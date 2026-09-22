import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { OnboardingSettingRows, TutorialPage, tutorialTopics } from './pages-maintenance'
import { macDesktopTutorialTopic, macRuntimeTutorialTopic } from './registry/business'
import { clientConnections } from './registry/clients'
import { pages } from './registry/pages'
import { errors } from './registry/errors'
import { statuses } from './registry/status'
import { accelerationTrialSeconds } from '../../electron/acceleration-contract'
import { runtimeButtonLabel, runtimeHomebrewCommand } from './features/tools/runtime-install-guide'

const pageIds = new Set<string>(pages.map((page) => page.id))
const pageLabels = new Map<string, string>(
  pages.map((page) => [page.id, page.label.replace(' ↗', '')]),
)

describe('tutorial topics', () => {
  it('covers the three extension pages with a chapter each', () => {
    for (const id of ['mcp', 'skills', 'plugins']) {
      const topic = tutorialTopics.find((entry) => entry.id === id)
      expect(topic, `缺少 ${id} 教程章节`).toBeDefined()
      // 章节标题与侧边导航上的页面名保持一致，用户搜哪个词都找得到。
      expect(topic?.title).toBe(pageLabels.get(id))
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

  it('covers the two daily pages that had no chapter at all', () => {
    // 记录页与加速页是 0.2.7~0.2.8 才成型的两块功能，教程里一度一个字都没有。
    for (const id of ['sessions', 'acceleration']) {
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

  it('states the three rules that decide whether 「接着聊」 is available', () => {
    // 这三条都是命令行工具本身的限制（只能按文件夹找回最近一条），用户看不出来，
    // 写错了会让人以为按钮坏了。
    const topic = tutorialTopics.find((entry) => entry.id === 'sessions')
    const text = topic?.steps.map((step) => step.detail).join('\n') ?? ''
    expect(text).toContain('最近的一次对话')
    expect(text).toContain('已归档')
    expect(text).toContain('文件夹已不存在')
    // 记录只在本机、保留期放长到一年，与记录页页头同一口径。
    expect(text).toContain('只存在这台电脑上')
    expect(text).toContain('一年')
  })

  it('quotes the free allowance from the contract and leaves the bonus code out', () => {
    // 免费时长由 acceleration-contract 定，教程里写死另一个数就会对不上。
    const topic = tutorialTopics.find((entry) => entry.id === 'acceleration')
    const text = topic?.steps.map((step) => step.detail).join('\n') ?? ''
    expect(text).toContain(`${accelerationTrialSeconds / 60} 分钟`)
    // 口令入口是彩蛋，教程不写；写进来这条会红。
    expect(text).not.toContain('口令')
    // 托盘菜单（#326）是主窗口缩起来时唯一的开关入口。
    expect(text).toContain('托盘')
    // 两处「自己连」的口径相反：下载那条不计时，Codex 桌面端那条计时且不自动断。
    expect(text).toContain('不计入免费时长')
    expect(text).toContain('不会自动断开')
    expect(text).toContain('加速服务暂不可用')
  })

  it('spells the error banners exactly as the error registry does', () => {
    // 对照表的价值全在「用户看到的那句话」能对上号，所以标题从 registry 取，
    // 改文案时这条会直接红。
    const topic = tutorialTopics.find((entry) => entry.id === 'messages')
    expect(topic, '缺少报错对照章节').toBeDefined()
    const text = topic?.steps.map((step) => step.detail).join('\n') ?? ''
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
    expect(text).toContain('这个文件夹范围太大')
  })

  it('names every tool that actually has a plugin marketplace', () => {
    // 教程一度写着市场仅 Codex，Claude Code 的官方市场接上之后这句就错了。
    const plugins = tutorialTopics.find((entry) => entry.id === 'plugins')
    const text = plugins?.steps.map((step) => step.detail).join('\n') ?? ''
    expect(text).toContain('Claude Code')
    expect(text).toContain('添加官方市场')
    expect(text).toContain('Codex CLI')
  })

  it('keeps the two safety notes the skipped Claude Code welcome page used to carry', () => {
    // #284 替用户跳过了 Claude Code 首启那页英文安全须知，这两句由本教程用中文承担，不能再掉。
    const start = tutorialTopics.find((entry) => entry.id === 'start')
    const text = start?.steps.map((step) => step.detail).join('\n') ?? ''
    expect(text).toContain('都可能出错')
    expect(text).toContain('合并或执行之前自己再过一遍')
    expect(text).toContain('来路不明')
    expect(text).toContain('藏着让 AI 去做别的事的指令')
  })

  it('tells a Mac customer how to install Node.js and Python by hand', () => {
    // 候选 10：macOS 上这两样应用不代装，首页给摘要、教程给完整步骤。
    const topic = tutorialTopics.find((entry) => entry.id === macRuntimeTutorialTopic)
    expect(topic, '缺少 macOS 运行环境教程章节').toBeDefined()
    const text = topic?.steps.map((step) => `${step.title}\n${step.detail}`).join('\n') ?? ''
    // 两条命令与首页那段提示必须是同一个字符串，否则两处文案会各走各的。
    expect(text).toContain(runtimeHomebrewCommand('node'))
    expect(text).toContain(runtimeHomebrewCommand('python'))
    expect(text).toContain(runtimeButtonLabel('node', 'external'))
    expect(text).toContain('.pkg')
    // 不代装、不提权这条口径要写在教程里，和运行环境卡一致。
    expect(text).toContain('星芒不会替你跑这条命令')
    expect(text).toContain('重新检测')
  })

  it('tells a Mac customer how to install the four desktop clients by hand', () => {
    // 第七批 3：macOS 上这四个桌面端点「安装」只能被带到教程，可教程里一度没有这一章。
    const topic = tutorialTopics.find((entry) => entry.id === macDesktopTutorialTopic)
    expect(topic, '缺少 macOS 桌面端教程章节').toBeDefined()
    const text = topic?.steps.map((step) => `${step.title}\n${step.detail}`).join('\n') ?? ''
    // 四个客户端的名字都要出现，名字从注册表取，改了名字这里会红。
    expect(text).toContain('Codex 桌面端')
    for (const client of clientConnections) expect(text, `教程里没写 ${client.name}`).toContain(client.name)
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

  it('opens at the chapter the caller asked for instead of the first one', () => {
    // 首页那几行「安装指南」跳过来时要直接停在 macOS 那一章（第七批 3）。
    const topic = tutorialTopics.find((entry) => entry.id === macDesktopTutorialTopic)
    const markup = renderToStaticMarkup(
      createElement(TutorialPage, { topic: { sequence: 1, id: macDesktopTutorialTopic } }),
    )
    expect(markup).toContain(`<h2>${topic?.title}</h2>`)
    expect(markup).toContain(topic?.steps[0]?.title ?? '')
  })

  it('falls back to the first chapter when the requested one does not exist', () => {
    const markup = renderToStaticMarkup(
      createElement(TutorialPage, { topic: { sequence: 1, id: 'no-such-chapter' } }),
    )
    expect(markup).toContain(`<h2>${tutorialTopics[0].title}</h2>`)
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

describe('settings onboarding entries', () => {
  it('offers both 「再看一遍」 and 「重看导览」 when the app can drive them', () => {
    const markup = renderToStaticMarkup(
      createElement(OnboardingSettingRows, { openGuide: () => undefined, replayTour: () => undefined }),
    )
    expect(markup).toContain('data-testid="settings-start-guide"')
    expect(markup).toContain('新手引导')
    expect(markup).toContain('再看一遍')
    expect(markup).toContain('data-testid="settings-replay-tour"')
    expect(markup).toContain('界面导览')
    expect(markup).toContain('重看导览')
    // 两行名字很像，说明必须把它们区分开，否则这一条改回了 A8 修的那个毛病。
    expect(markup).toContain('已经填好的账号和密钥不会被清空')
  })

  it('hides the tour entry when the host cannot replay it', () => {
    const markup = renderToStaticMarkup(
      createElement(OnboardingSettingRows, { openGuide: () => undefined }),
    )
    expect(markup).toContain('data-testid="settings-start-guide"')
    expect(markup).not.toContain('data-testid="settings-replay-tour"')
  })
})
