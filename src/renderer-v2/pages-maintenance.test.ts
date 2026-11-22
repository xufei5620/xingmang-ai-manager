import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FeedbackPage, HealthPage, OnboardingGuideRow, OnboardingTourRow, SettingsPage, TutorialPage, connectionRowStatus, feedbackCopyNotice, feedbackErrorCount, feedbackExportNotice, installGuideTopic, installJobRunning, installResultMessage, launchShortcutMeta, shortcutRows, settingsPageLead, sortConnectionRows, sortDiagnosticsBySeverity, tutorialTopics } from './pages-maintenance'
import type { V2Bridge } from './types'
import { VersionCard } from './features/settings/VersionCard'
import { macDesktopTutorialTopic, macRuntimeTutorialTopic } from './registry/business'
import { tutorialCategories, tutorialTopicsFor } from './registry/tutorials'
import { tutorialIcons } from './features/tutorial/TutorialPage'
import { clientConnections } from './registry/clients'
import { pages } from './registry/pages'
import { errors } from './registry/errors'
import { statuses } from './registry/status'
import { runtimeButtonLabel, runtimeHomebrewCommand } from './features/tools/runtime-install-guide'
import * as healthPage from './features/health/HealthPage'
import * as feedbackPage from './features/feedback/FeedbackPage'
import * as settingsPage from './features/settings/SettingsPage'
import * as installResult from './features/tools/install-result'

const pageIds = new Set<string>(pages.map((page) => page.id))
const pageLabels = new Map<string, string>(
  pages.map((page) => [page.id, page.label.replace(' ↗', '')]),
)

describe('paid Codex check in HealthPage', () => {
  it('stays hidden until the page knows Codex is installed and leaves the self-check wording alone', () => {
    const markup = renderToStaticMarkup(createElement(HealthPage, { api: {} as V2Bridge }))
    expect(markup).not.toContain('health-codex-responses')
    expect(markup).toContain('确认各工具连接正常、账号有效；已安装的桌面端一并检测')
  })
})

// Gemini CLI 下线（yoyo 2026-10-14）：「信任安全证书」只为它从星芒打开时用，主进程那条通道一起撤了，
// 检查页不再有这颗按钮，也不再出现它的名字。
describe('maintenance pages without the retired Gemini CLI', () => {
  it('offers no certificate trust button on the health page', () => {
    const markup = renderToStaticMarkup(createElement(HealthPage, { api: {} as V2Bridge }))
    expect(markup).not.toContain('health-trust-certificates')
    expect(markup).not.toContain('Gemini')
  })

  // 设置里「快捷键」写的数字跟着这台电脑看得到的工具走，不再写死 1–5；键名按这台电脑只写一种（字表批09）。
  it('numbers the launch shortcut over the tools this computer shows', () => {
    expect(launchShortcutMeta('win')).toBe('Ctrl 1–4')
    expect(launchShortcutMeta('mac')).toBe('⌘ 1–4')
    expect(launchShortcutMeta('linux')).toBe('Ctrl 1–3')
  })

  it('lists the shortcuts the app actually answers, in the keys of this computer', () => {
    expect(shortcutRows('mac').map((row) => `${row.keys} ${row.label}`)).toEqual([
      '⌘ K 搜索或跳转',
      '/ 在有搜索框的页面里直接搜索',
      '⌘ , 打开设置',
      '⌘ 1–4 打开工具',
      '⌘ + / ⌘ - 放大 / 缩小界面',
      '⌘ 0 恢复自动缩放',
      '⌃ ⌘ F 全屏',
      'Esc 关闭弹窗或菜单',
    ])
    for (const os of ['win', 'linux'] as const) expect(shortcutRows(os).every((row) => !row.keys.includes('⌘'))).toBe(true)
    for (const os of ['win', 'linux'] as const) expect(shortcutRows(os)).toContainEqual({ keys: 'F11', label: '全屏' })
  })
})

describe('health page order', () => {
  it('puts the export next to the check button in the page head and the two explanation cards after the results', () => {
    const markup = renderToStaticMarkup(createElement(HealthPage, { api: {} as V2Bridge }))
    const head = markup.indexOf('导出检查报告')
    expect(head).toBeGreaterThan(-1)
    expect(head).toBeLessThan(markup.indexOf('开始检查'))
    expect(markup.indexOf('开始检查')).toBeLessThan(markup.indexOf('xm-card-none'))
    expect(markup.indexOf('xm-card-none')).toBeLessThan(markup.indexOf('连接自检'))
  })

  // UI 字表 W33：还一项结果都没有时，页头那颗不叫「重新检查」，跟空状态那句「点右上角「开始检查」。」对得上。
  it('names the head button 开始检查 before any check has produced results', () => {
    const markup = renderToStaticMarkup(createElement(HealthPage, { api: {} as V2Bridge }))
    expect(markup).toContain('开始检查')
    expect(markup).not.toContain('重新检查')
  })

  it('lists problems before warnings before passing items and keeps the order within each', () => {
    const items = [
      { code: 'A', state: 'pass' }, { code: 'B', state: 'warn' }, { code: 'C', state: 'fail' },
      { code: 'D', state: 'pass' }, { code: 'E', state: 'error' }, { code: 'F', state: 'warn' },
    ]
    expect(sortDiagnosticsBySeverity(items).map((item) => item.code)).toEqual(['C', 'E', 'B', 'F', 'A', 'D'])
    expect(items.map((item) => item.code)).toEqual(['A', 'B', 'C', 'D', 'E', 'F'])
  })

  it('labels each self-check row 正常, 有问题 or 检测未完成 and keeps an unconfigured tool grey', () => {
    const base = { siteId: 'solov', endpoint: null, model: null, detail: null, status: null, durationMs: 1, checkedAt: '2026-10-04T00:00:00Z', nextStep: '照着做' }
    const ok = { ...base, provider: 'claude' as const, ok: true, layer: 'network' as const, summary: '连接正常' }
    const broken = { ...base, provider: 'codex' as const, ok: false, layer: 'credential' as const, summary: '密钥不对' }
    const service = { ...base, provider: 'grok' as const, ok: false, layer: 'service' as const, summary: '服务在维护' }
    const unconfigured = { ...base, provider: 'claude' as const, ok: false, layer: 'unconfigured' as const, summary: '还没配' }
    expect(connectionRowStatus({ result: ok })).toEqual({ label: '正常', tone: 'ok' })
    expect(connectionRowStatus({ result: broken })).toEqual({ label: '有问题', tone: 'bad' })
    expect(connectionRowStatus({ result: service })).toEqual({ label: '有问题', tone: 'warn' })
    expect(connectionRowStatus({ result: unconfigured })).toEqual({ label: '未配置', tone: 'neutral' })
    expect(connectionRowStatus({ result: null })).toEqual({ label: '检测未完成', tone: 'bad' })
    const rows = [
      { id: 'claude', result: ok }, { id: 'opencode', result: unconfigured }, { id: 'codex', result: broken },
      { id: 'workbuddy', result: null }, { id: 'grok', result: service },
    ]
    expect(sortConnectionRows(rows).map((row) => row.id)).toEqual(['codex', 'grok', 'workbuddy', 'opencode', 'claude'])
  })
})

describe('feedback report notices', () => {
  const fresh = { id: 'report-2', text: 'fresh report\n', entries: 3 }

  it('keeps the plain wording when the previewed report was still current', () => {
    expect(feedbackCopyNotice({ entries: 3 })).toBe('报告已复制')
    expect(feedbackExportNotice({ outputPath: 'C:/r.txt' })).toEqual({ text: '反馈报告已导出：C:/r.txt', revealPath: 'C:/r.txt' })
  })

  it('tells the user the report was refreshed after the preview expired', () => {
    expect(feedbackCopyNotice({ entries: 3, regenerated: fresh })).toBe('报告已更新至最新日志并复制，请发送给客服')
    expect(feedbackExportNotice({ outputPath: 'C:/r.txt', regenerated: fresh })).toEqual({
      text: '报告已更新到最新日志并导出：C:/r.txt',
      revealPath: 'C:/r.txt',
    })
  })

  it('claims nothing when the save dialog was dismissed', () => {
    expect(feedbackExportNotice(null)).toBeNull()
  })
})

describe('feedback and support page', () => {
  const support = { identity: '账号 yoyo（ID 7） · 星芒AI管理工具 0.2.19 · Windows', open: () => undefined, copyIdentity: () => undefined }

  it('opens on the message form with the support card and the first things to try', () => {
    const markup = renderToStaticMarkup(createElement(FeedbackPage, { api: {} as V2Bridge, support }))
    expect(markup).toContain('<h1>反馈与客服</h1>')
    expect(markup).toContain('role="tablist"')
    expect(markup).toContain('留言反馈')
    expect(markup).toContain('运行日志')
    expect(markup).toContain('问题描述')
    expect(markup).toContain('例如：点击「打开」后终端窗口闪退')
    expect(markup).toContain('微信号或邮箱（将一并复制，便于客服联系您）')
    expect(markup).toContain('已自动隐去密钥和个人路径')
    expect(markup).toContain('复制给客服')
    expect(markup).toContain('data-testid="feedback-support-card"')
    expect(markup).toContain('微信扫码添加客服')
    expect(markup).toContain('data-testid="feedback-support-identity-line"')
    expect(markup).toContain('预览反馈报告')
    for (const id of ['health', 'orders', 'tutorial', 'mcp']) expect(markup).toContain(`data-testid="feedback-try-${id}"`)
    // 两个页签都挂着、只藏不卸：一开始藏起来的是运行日志那一块。
    expect(markup).toContain('id="feedback-panel-form" role="tabpanel" aria-label="留言反馈" data-testid')
    expect(markup).toContain('id="feedback-panel-log" role="tabpanel" aria-label="运行日志" hidden=""')
    // 报告预览的隐私说明挪进了弹窗，页面上不再有横条。
    expect(markup).not.toContain('feedback-privacy')
  })

  it('leaves out the orders shortcut for an account without orders and the support card when there is none', () => {
    const markup = renderToStaticMarkup(createElement(FeedbackPage, { api: {} as V2Bridge, ordersVisible: false }))
    expect(markup).not.toContain('feedback-try-orders')
    expect(markup).not.toContain('feedback-support-card')
    expect(markup).toContain('feedback-try-health')
  })

  it('lands on the run log when another page asks for it', () => {
    const markup = renderToStaticMarkup(createElement(FeedbackPage, { api: {} as V2Bridge, feedbackRequest: { sequence: 1, tab: 'log' } }))
    expect(markup).toContain('data-testid="feedback-search"')
    expect(markup).toContain('打开日志文件夹')
    expect(markup).toContain('aria-label="刷新"')
    expect(markup).toContain('日志仅保存在本机。')
    // 留言那一块还挂着（写到一半的字不丢），只是藏起来。
    expect(markup).toContain('id="feedback-panel-form" role="tabpanel" aria-label="留言反馈" hidden=""')
    expect(markup).toContain('id="feedback-panel-log" role="tabpanel" aria-label="运行日志" data-testid')
  })
})

describe('feedbackErrorCount', () => {
  it('counts only the errors logged since this launch', () => {
    const startedAt = '2026-10-16T08:00:00.000Z'
    const entry = (id: string, level: string, timestamp: string) => ({ id, level, timestamp, source: 'main', event: 'x', message: 'm' })
    const snapshot = {
      currentProcessId: 42,
      startedAt,
      entries: [
        entry('2026-10-16T08:01:00.000Z:42:1', 'error', '2026-10-16T08:01:00.000Z'),
        entry('2026-10-16T08:02:00.000Z:42:2', 'warn', '2026-10-16T08:02:00.000Z'),
        entry('2026-10-15T08:01:00.000Z:17:1', 'error', '2026-10-15T08:01:00.000Z'),
      ],
    } as Parameters<typeof feedbackErrorCount>[0]
    expect(feedbackErrorCount(snapshot)).toBe(1)
    expect(feedbackErrorCount(undefined)).toBe(0)
  })
})

function tutorialText(id: string): string {
  const topic = tutorialTopics.find((entry) => entry.id === id)
  if (!topic) return ''
  return [
    topic.title,
    topic.lead,
    ...(topic.reminders ?? []),
    ...topic.steps.flatMap((step) => [
      step.title,
      step.detail,
      step.where,
      ...(step.bullets ?? []),
      step.expected,
      step.tip,
      step.example,
      ...(step.extra ?? []).flatMap((item) => [item.title, item.detail]),
    ]),
  ].filter(Boolean).join('\n')
}

describe('tutorial topics', () => {
  it('covers the three extension pages with a chapter each', () => {
    // #1993 起侧栏只剩一页「插件」，三章的标题不再跟旧页名一一对应，照 yoyo 回「插件教程改」那份逐字稿：
    // 外接工具那章改叫「连上浏览器和文件夹」，免得跟页面名「插件」撞；插件那章改叫「官方插件和插件市场」。
    const titles: Record<string, string> = { mcp: '连上浏览器和文件夹', skills: '技能', plugins: '官方插件和插件市场' }
    for (const id of ['mcp', 'skills', 'plugins']) {
      const topic = tutorialTopics.find((entry) => entry.id === id)
      expect(topic, `缺少 ${id} 教程章节`).toBeDefined()
      expect(topic?.title).toBe(titles[id])
      expect(topic?.lead.length).toBeGreaterThan(0)
      // 是什么 / 怎么加 / 怎么验证 / 报错怎么办，四步缺一不可。
      expect(topic?.steps.length).toBe(4)
      for (const step of topic?.steps ?? []) {
        expect(step.title.length).toBeGreaterThan(0)
        expect(step.detail.length).toBeGreaterThan(0)
        expect(step.action.length).toBeGreaterThan(0)
      }
    }
  })

  it('covers the sessions page that had no chapter at all', () => {
    // 记录页是 0.2.7~0.2.8 才成型的功能，教程里一度一个字都没有。加速页那一章 2026-10-30 随加速下线去掉了。
    for (const id of ['sessions']) {
      const topic = tutorialTopics.find((entry) => entry.id === id)
      expect(topic, `缺少 ${id} 教程章节`).toBeDefined()
      expect(topic?.title).toBe(pageLabels.get(id))
      expect(topic?.lead.length).toBeGreaterThan(0)
      expect(topic?.steps.length).toBe(4)
      for (const step of topic?.steps ?? []) {
        expect(step.title.length).toBeGreaterThan(0)
        expect(step.detail.length).toBeGreaterThan(0)
        expect(step.action.length).toBeGreaterThan(0)
      }
    }
  })

  it('states the three rules that decide whether 「继续对话」 is available', () => {
    // 这三条都是命令行工具本身的限制（只能按文件夹找回最近一条），用户看不出来，
    // 写错了会让人以为按钮坏了。
    const text = tutorialText('sessions')
    expect(text).toContain('最近一次对话')
    expect(text).toContain('已归档')
    expect(text).toContain('文件夹已不存在')
    // 记录只在本机、保留期放长到一年，与记录页页头同一口径。
    expect(text).toContain('仅保存在本机')
    expect(text).toContain('一年')
  })

  it('spells the error banners exactly as the error registry does', () => {
    // 对照表的价值全在「用户看到的那句话」能对上号，所以标题从 registry 取，
    // 改文案时这条会直接红。
    const topic = tutorialTopics.find((entry) => entry.id === 'messages')
    expect(topic, '缺少报错对照章节').toBeDefined()
    const text = tutorialText('messages')
    for (const key of [
      'diskFull',
      'permission',
      'installBlocked',
      'toolRunning',
      'downloadTimeout',
      'tlsIntercepted',
      'certDate',
      'timeout',
      'tooManyRequests',
      'sessionExpired',
      'keyInvalid',
      'noBalance',
    ] as const)
      expect(text, `对照表缺少「${errors[key].title}」`).toContain(errors[key].title)
    // 首页工具行上的两个标记同理，取自状态注册表。
    expect(text).toContain(statuses.tool.configChanged[0])
    expect(text).toContain(statuses.tool.detectionFailed[0])
    // 敏感目录提示的标题在 electron/workspace-guard.ts，那侧是主进程模块，这里只钉字面。
    expect(text).toContain('该文件夹范围过大')
  })

  it('quotes what the command-line tools really print when the balance or key quota runs out', () => {
    // 原文取自四家推荐版本对本地假接口的实测（服务端返回按 new-api rc.24 源码构造）。
    // 小白最容易踩的是 Claude Code 在余额不足时也说「Please run /login」，照做会走官方登录。
    const text = tutorialText('messages')
    for (const phrase of ['Please run /login', '用户额度不足', 'token quota is not enough', 'API key 额度已用完', 'Quota exceeded', '无效的令牌', '请勿照做'])
      expect(text, `对照表缺少「${phrase}」`).toContain(phrase)
    expect(text).not.toMatch(/星芒余额|solov|Sub2API/)
  })

  it('names every tool that actually has a plugin marketplace', () => {
    // 教程一度写着市场仅 Codex，Claude Code 的官方市场接上之后这句就错了。#1993 起「插件」页按「Claude 官方」
    // 「GPT 官方」分组，教程跟着页面叫法写，各自只能装进哪一家、Grok 没有市场也要说到。
    const plugins = tutorialTopics.find((entry) => entry.id === 'plugins')
    const text = plugins?.steps.flatMap((step) => [step.detail, ...(step.extra ?? []).map((item) => item.detail)]).join('\n') ?? ''
    expect(text).toContain('「Claude 官方」')
    expect(text).toContain('只能装进 Claude')
    expect(text).toContain('添加官方市场')
    expect(text).toContain('「GPT 官方」')
    expect(text).toContain('只能装进 GPT')
    expect(text).toContain('Grok 没有插件市场')
  })

  it('keeps the two safety notes the skipped Claude Code welcome page used to carry', () => {
    // #284 替用户跳过了 Claude Code 首启那页英文安全须知，这两句由本教程用中文承担，不能再掉。
    const start = tutorialTopics.find((entry) => entry.id === 'start')
    const text = [...(start?.steps.map((step) => step.detail) ?? []), ...(start?.reminders ?? [])].join('\n')
    expect(text).toContain('都可能出错')
    expect(text).toContain('合并或执行之前自己再过一遍')
    expect(text).toContain('来源不明')
    expect(text).toContain('诱导 AI 执行其他操作的指令')
  })

  it('tells a Mac customer to let the app prepare Node.js and how to install both by hand', () => {
    // 候选 10：macOS 上 Python 应用不代装，首页给摘要、教程给完整步骤。第十六批 2 起
    // Node.js 由应用准备，手动装法留给想自己装的人。
    const topic = tutorialTopics.find((entry) => entry.id === macRuntimeTutorialTopic)
    expect(topic, '缺少 macOS 运行环境教程章节').toBeDefined()
    const text = tutorialText(macRuntimeTutorialTopic)
    // 两条命令与首页那段提示必须是同一个字符串，否则两处文案会各走各的。
    expect(text).toContain(runtimeHomebrewCommand('node'))
    expect(text).toContain(runtimeHomebrewCommand('python'))
    expect(text).toContain(runtimeButtonLabel('node', 'managed'))
    expect(text).toContain(runtimeButtonLabel('python', 'external'))
    expect(text).toContain('无需输入开机密码')
    expect(text).toContain('.pkg')
    // 不代装、不提权这条口径要写在教程里，和运行环境卡一致。
    expect(text).toContain('星芒不会代为执行此命令')
    expect(text).toContain('重新检测')
  })

  it('tells a Mac customer how to install the desktop clients by hand', () => {
    // 第七批 3：macOS 上这几个桌面端点「安装」只能被带到教程，可教程里一度没有这一章。
    const topic = tutorialTopics.find((entry) => entry.id === macDesktopTutorialTopic)
    expect(topic, '缺少 macOS 桌面端教程章节').toBeDefined()
    const text = tutorialText(macDesktopTutorialTopic)
    // 星芒装得了的客户端名字都要出现，名字从注册表取，改了名字这里会红。WorkBuddy 星芒不装、不给下载
    // （yoyo 2026-11-18「下线」），首页不再带人来这一章，这一章也不再提它。
    expect(text).toContain('Codex 桌面端')
    for (const client of clientConnections) {
      if (client.id === 'workbuddy') expect(text).not.toContain(client.name)
      else expect(text, `教程里没写 ${client.name}`).toContain(client.name)
    }
    // 检测只认「应用程序」文件夹里的官方应用名，这两条不写清楚客户就卡在「装了但检测不到」。
    expect(text).toContain('应用程序')
    expect(text).toContain('重新检测')
    // 装完怎么连当前账号是这一章的另一半；口径与外部客户端配置弹窗一致。
    expect(text).toContain('检测模型')
    expect(text).toContain('当前账号')
    // 这两条各自的坑：Claude Desktop 要完全退出重开，Codex 两端共用一份配置。
    expect(text).toContain('完全退出')
    expect(text).toContain('共用一份配置')
  })

  it('opens at the chapter the caller asked for instead of the card list', () => {
    // 首页那几行「安装指南」跳过来时要直接停在 macOS 那一章（第七批 3）。
    // 教程按电脑分版本（Linux 版没有这一章），这里说明是在 Mac 上，测试跑在哪台机器都一样。
    const topic = tutorialTopics.find((entry) => entry.id === macDesktopTutorialTopic)
    const markup = renderToStaticMarkup(
      createElement(TutorialPage, { os: 'mac', topic: { sequence: 1, id: macDesktopTutorialTopic } }),
    )
    expect(markup).toContain(`<h2 id="tutorial-article-title">${topic?.title}</h2>`)
    expect(markup).toContain(topic?.steps[0]?.title ?? '')
    expect(markup).toContain('data-testid="tutorial-back"')
    expect(markup).toContain('全部教程')
    expect(markup).toContain(`${topic?.steps.length} 步，约 ${topic?.minutes} 分钟`)
    expect(markup).not.toContain('data-testid="tutorial-cards"')
  })

  it('carries the text typed in the top search into the tutorial search box on the card list', () => {
    const markup = renderToStaticMarkup(
      createElement(TutorialPage, { topic: { sequence: 1, id: 'start', query: '充值' } }),
    )
    expect(markup).toMatch(/data-testid="tutorial-search"[^>]*value="充值"|value="充值"[^>]*data-testid="tutorial-search"/)
    expect(markup).toContain('data-testid="tutorial-card-account"')
    expect(markup).not.toContain('data-testid="tutorial-article"')
    expect(markup).toContain('<mark class="v2-tutorial-hit">充值</mark>')
  })

  it('shows the card list when the requested chapter does not exist', () => {
    const markup = renderToStaticMarkup(
      createElement(TutorialPage, { topic: { sequence: 1, id: 'no-such-chapter' } }),
    )
    expect(markup).not.toContain('data-testid="tutorial-article"')
    expect(markup).toContain(`data-testid="tutorial-card-${tutorialTopics[0].id}"`)
  })

  it('lists one card per chapter with categories, counts and the first chapter as the lead', () => {
    const markup = renderToStaticMarkup(createElement(TutorialPage, { os: 'win' }))
    for (const topic of tutorialTopics) expect(markup).toContain(`data-testid="tutorial-card-${topic.id}"`)
    expect(markup).toContain('aria-label="按类别筛选"')
    expect(markup).toContain('placeholder="搜索教程，比如「切换账号」"')
    for (const label of ['全部', '入门', '工具', '账号与费用', '出问题时']) expect(markup).toContain(`>${label}<span class="xm-chip-count">`)
    expect(markup).toContain(`全部<span class="xm-chip-count">${tutorialTopics.length}</span>`)
    expect(markup).toContain(`入门<span class="xm-chip-count">${tutorialTopics.filter((topic) => topic.category === 'start').length}</span>`)
    // 第一张是「从这里开始」：金色那张、主按钮；其余卡片都是普通按钮。
    expect(markup).toMatch(/class="v2-tutorial-card is-lead"[^>]*data-testid="tutorial-card-start"/)
    expect(markup.match(/is-lead/g)?.length).toBe(1)
    const first = tutorialTopics[0]
    expect(markup).toContain(`${first.steps.length} 步，约 ${first.minutes} 分钟`)
    expect(markup).toMatch(/xm-btn-primary[^>]*data-testid="tutorial-topic-start"/)
    expect(markup).not.toContain('先让 Codex 回你一句话')
    expect(markup).not.toContain('找到 ')
  })

  it('opens the Linux chapters on a Linux computer and keeps the Windows chapters elsewhere', () => {
    // Linux 版拆分 ⑩：Linux 上第一章是 Codex CLI，没有桌面端和加速那几章。
    const linux = tutorialTopicsFor('linux')
    const linuxMarkup = renderToStaticMarkup(createElement(TutorialPage, { os: 'linux' }))
    expect(linuxMarkup).toContain(`data-testid="tutorial-card-${linux[0].id}"`)
    expect(linuxMarkup).toContain('Codex CLI')
    expect(linuxMarkup).not.toContain('桌面端')
    expect(linuxMarkup).not.toContain('网络加速')
    expect(linuxMarkup).toContain(`全部<span class="xm-chip-count">${linux.length}</span>`)
    // 要的那一章 Linux 上没有（比如 Mac 桌面端），落回 Linux 的卡片列表，不显示 Windows 那份。
    const fallback = renderToStaticMarkup(createElement(TutorialPage, { os: 'linux', topic: { sequence: 1, id: macDesktopTutorialTopic } }))
    expect(fallback).not.toContain('data-testid="tutorial-article"')
    expect(fallback).not.toContain('桌面端')
    const linuxArticle = renderToStaticMarkup(createElement(TutorialPage, { os: 'linux', topic: { sequence: 1, id: 'start' } }))
    expect(linuxArticle).toContain(`<h2 id="tutorial-article-title">${linux[0].title}</h2>`)
    const windowsMarkup = renderToStaticMarkup(createElement(TutorialPage, { os: 'win' }))
    expect(windowsMarkup).toContain(`data-testid="tutorial-card-${macDesktopTutorialTopic}"`)
    // 网络加速 2026-10-30 下线：Windows、Mac 上也没有那一章了。
    expect(windowsMarkup).not.toContain('网络加速')
  })

  it('gives every chapter on every computer a category and its own card icon', () => {
    for (const os of ['win', 'mac', 'linux'] as const)
      for (const topic of tutorialTopicsFor(os)) {
        expect(tutorialCategories.some((entry) => entry.value !== 'all' && entry.value === topic.category)).toBe(true)
        expect(tutorialIcons[topic.id], topic.id).toBeDefined()
      }
    // 每一类都至少有一篇，分类按钮不会点出一片空白。
    for (const entry of tutorialCategories)
      expect(entry.value === 'all' || tutorialTopicsFor('linux').some((topic) => topic.category === entry.value), entry.value).toBe(true)
  })

  it('only links steps at pages the shell can actually navigate to', () => {
    for (const topic of tutorialTopics)
      for (const step of topic.steps) expect(pageIds.has(step.page)).toBe(true)
  })

  it('keeps every topic id unique so the chapter list stays selectable', () => {
    const ids = tutorialTopics.map((topic) => topic.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('settings page lead', () => {
  // 找设置改用左栏的「搜索设置」，顶上只说会自己保存（字表批08）。
  it('only says changes save themselves now that the page has its own search', () => {
    expect(settingsPageLead).toBe('改动会立即保存。')
  })
})

// Fable 第二轮 Q6：拨完开关那句小提示按主进程实际做了什么说，没改 Claude Code 配置的两种不说「已打开」。
describe('Claude Code write boundary notice', () => {
  it('says the switch took effect only when the config was written or already matched', () => {
    expect(settingsPage.claudeWriteBoundaryNotice({ enabled: true, applied: 'written' })).toEqual({ text: '已开启，新打开的 Claude Code 将按此设置运行。', tone: 'ok' })
    expect(settingsPage.claudeWriteBoundaryNotice({ enabled: true, applied: 'unchanged' })).toEqual({ text: '已开启，新打开的 Claude Code 将按此设置运行。', tone: 'ok' })
    expect(settingsPage.claudeWriteBoundaryNotice({ enabled: false, applied: 'written' })).toEqual({ text: '已关闭，新打开的 Claude Code 将不再限制文件修改范围。', tone: 'ok' })
  })

  it('tells the customer when their own Claude Code setting was left alone or the write waits for the next save', () => {
    for (const enabled of [true, false]) {
      expect(settingsPage.claudeWriteBoundaryNotice({ enabled, applied: 'kept' })).toEqual({ text: '设置已记录。Claude Code 自身设置中已有此项，星芒未作修改。', tone: 'warn' })
      expect(settingsPage.claudeWriteBoundaryNotice({ enabled, applied: 'later' })).toEqual({ text: '设置已记录，将在下次保存 Claude Code 配置时一并写入。', tone: 'ok' })
    }
  })
})

// 同类对比 备选 6：「不署名」开关的小提示，没改 Claude Code 配置的两种跟上面那个开关说同一套。
describe('Claude Code commit attribution notice', () => {
  it('names what changes for the next Claude Code and falls back to the shared kept and later wording', () => {
    expect(settingsPage.claudeCommitAttributionNotice({ enabled: true, applied: 'written' })).toEqual({ text: '已开启，新打开的 Claude Code 提交代码时将不再署名。', tone: 'ok' })
    expect(settingsPage.claudeCommitAttributionNotice({ enabled: false, applied: 'unchanged' })).toEqual({ text: '已关闭，新打开的 Claude Code 提交代码时将照常署名。', tone: 'ok' })
    expect(settingsPage.claudeCommitAttributionNotice({ enabled: true, applied: 'kept' })).toEqual({ text: '设置已记录。Claude Code 自身设置中已有署名项，星芒未作修改。', tone: 'warn' })
    expect(settingsPage.claudeCommitAttributionNotice({ enabled: true, applied: 'later' })).toEqual(settingsPage.claudeWriteBoundaryNotice({ enabled: true, applied: 'later' }))
  })
})

describe('settings page before the settings arrive', () => {
  it('says it is still reading instead of claiming anything is unsupported', () => {
    const markup = renderToStaticMarkup(createElement(SettingsPage, { api: {} as V2Bridge }))
    expect(markup).toContain('正在读取设置…')
    expect(markup).not.toContain('本机不可用')
    expect(markup).toContain('<span>版本更新</span></button>')
    expect(markup).not.toContain('<span>账号</span></button>')
    expect(markup).toContain('aria-label="搜索设置"')
  })

  it('lists the eight v4 groups with their icons, backup and migration included', () => {
    const markup = renderToStaticMarkup(createElement(SettingsPage, { api: {} as V2Bridge }))
    const names = [...markup.matchAll(/role="tab"[^>]*>.*?<span>([^<]+)<\/span>/g)].map((match) => match[1])
    expect(names).toEqual(['外观显示', '启动关闭', '工具管理', '网络连接', '消息通知', '备份迁移', '隐私数据', '版本更新'])
    expect(markup).toMatch(/id="v2-settings-appearance"[^>]*><svg/)
  })

  it('marks the update group when a new version is out and the network group while accelerating', () => {
    const idle = renderToStaticMarkup(createElement(SettingsPage, { api: {} as V2Bridge }))
    expect(idle).not.toContain('v2-settings-nav-dot')
    const markup = renderToStaticMarkup(createElement(SettingsPage, { api: {} as V2Bridge, updateAvailable: true, accelerating: true }))
    expect(markup).toMatch(/title="有新版本"[^>]*>.*?<span>版本更新<\/span><i class="v2-settings-nav-dot" aria-hidden="true">/)
    expect(markup).toMatch(/title="加速中"[^>]*>.*?<span>网络连接<\/span><i class="v2-settings-nav-dot is-ok" aria-hidden="true">/)
  })
})

// 原来的更新页并进了设置 › 版本更新（v4 批09）：两颗开关是那一组下面的两行，最上面是这张版本卡。
describe('version card', () => {
  it('names the app and waits for the update state before writing a version', () => {
    const markup = renderToStaticMarkup(createElement(VersionCard, { api: {} as V2Bridge, autoUpdate: true }))
    expect(markup).toContain('data-testid="page-updates"')
    expect(markup).toContain('<h2 id="v2-version-card-title">星芒AI管理工具</h2>')
    expect(markup).toMatch(/data-testid="updates-current-version"[^>]*>正在读取更新状态…</)
    expect(markup).toMatch(/<button[^>]*>.*?<span>检查更新<\/span><\/button>/)
    expect(markup).not.toContain('<details')
    // 两颗开关不在卡上再摆一份。
    expect(markup).not.toContain('启动时检查新版本')
  })
})

describe('settings onboarding entries', () => {
  // v4 去掉了两行的说明（字表批08），两行靠标题和按钮字分开：「新手引导 · 再看一遍」「界面导览 · 重看导览」。
  it('offers 「再看一遍」 and 「重看导览」 under their own titles without a description', () => {
    const guide = renderToStaticMarkup(createElement(OnboardingGuideRow, { openGuide: () => undefined }))
    const tour = renderToStaticMarkup(createElement(OnboardingTourRow, { replayTour: () => undefined }))
    expect(guide).toContain('data-testid="settings-start-guide"')
    expect(guide).toContain('<strong>新手引导</strong>')
    expect(guide).toContain('再看一遍')
    expect(tour).toContain('data-testid="settings-replay-tour"')
    expect(tour).toContain('<strong>界面导览</strong>')
    expect(tour).toContain('重看导览')
    expect(`${guide}${tour}`).not.toContain('<p>')
  })

  it('marks both rows so the top search can scroll to them', () => {
    expect(renderToStaticMarkup(createElement(OnboardingGuideRow, { openGuide: () => undefined }))).toContain('data-anchor="guide"')
    expect(renderToStaticMarkup(createElement(OnboardingTourRow, { replayTour: () => undefined }))).toContain('data-anchor="tour"')
  })
})

describe('installGuideTopic', () => {
  it('sends each install guide button to the chapter that installs it instead of the first chapter', () => {
    const title = (id: string) => tutorialTopics.find((entry) => entry.id === id)?.title
    expect(title(installGuideTopic('codexDesktop', 'macos'))).toBe('Mac 上装桌面端')
    expect(title(installGuideTopic('codexDesktop', 'windows'))).toBe('Codex 桌面端怎么安装？')
    for (const provider of ['claude', 'codex', 'grok'] as const) {
      expect(title(installGuideTopic(provider, 'macos'))).toBe('进阶：安装与使用命令行工具')
      expect(title(installGuideTopic(provider, 'windows'))).toBe('进阶：安装与使用命令行工具')
    }
    for (const runtime of ['node', 'python'] as const) {
      expect(title(installGuideTopic(runtime, 'macos'))).toBe('Mac 上准备 Node.js 和 Python')
      expect(title(installGuideTopic(runtime, 'windows'))).toBe('进阶：安装与使用命令行工具')
      expect(title(installGuideTopic(runtime, 'linux'))).toBe('进阶：安装与使用命令行工具')
      // 还没读到是哪种电脑时不猜 Mac。
      expect(title(installGuideTopic(runtime, undefined))).toBe('进阶：安装与使用命令行工具')
    }
  })
})

describe('installResultMessage', () => {
  // Q33：装工具都走首页那条安装之后，结果不止「装好 / 取消」两种。
  it('does not claim success when the install stopped for a restart or never started', () => {
    expect(installResultMessage('installed')).toBe('安装完成，工具状态已更新')
    expect(installResultMessage('cancelled')).toBe('安装已取消')
    expect(installResultMessage('restart')).toContain('重启电脑')
    expect(installResultMessage('skipped')).not.toContain('安装完成')
  })

  it('says nothing when the customer turned down switching the official-installer copy', () => {
    expect(installResultMessage('declined')).toBeNull()
  })
})

describe('installJobRunning', () => {
  // 首页的卸载也挂在工具编号下；扩展页那一行不能把它当成在装，标「安装中」。
  it('counts a Home job as an install unless it is an uninstall', () => {
    expect(installJobRunning(undefined)).toBe(false)
    expect(installJobRunning({ label: '正在安装', log: [] })).toBe(true)
    expect(installJobRunning({ label: '正在卸载', log: [], kind: 'uninstall' })).toBe(false)
  })
})

// #1070 第 11 步把三页搬出去以后 pages-maintenance 只做转出：转出的就是页面文件里那一份；页面文件也不反过来
// 从它那里 import 值，免得几个文件绕着圈 import，谁先求值谁拿到一半。
describe('pages-maintenance as a re-export of the split pages', () => {
  it('re-exports the very functions the page files define', () => {
    expect(HealthPage).toBe(healthPage.HealthPage)
    expect(sortDiagnosticsBySeverity).toBe(healthPage.sortDiagnosticsBySeverity)
    expect(FeedbackPage).toBe(feedbackPage.FeedbackPage)
    expect(SettingsPage).toBe(settingsPage.SettingsPage)
    expect(shortcutRows).toBe(settingsPage.shortcutRows)
    expect(installResultMessage).toBe(installResult.installResultMessage)
  })

  it('keeps the moved files from importing back out of it', () => {
    for (const file of ['features/health/HealthPage.tsx', 'features/feedback/FeedbackPage.tsx', 'features/settings/SettingsPage.tsx', 'features/tools/install-result.ts', 'business-actions.ts']) {
      expect(readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')).not.toMatch(/from '[./]*pages-maintenance'/)
    }
  })
})
