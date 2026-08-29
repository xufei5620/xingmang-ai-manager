import { useMemo, useState, type ReactNode } from 'react'
import {
  ArchiveRestore,
  Bot,
  CircleHelp,
  Download,
  ExternalLink,
  Gauge,
  KeyRound,
  LifeBuoy,
  Search,
  Settings,
  ShieldCheck,
  UserRound,
  Wallet,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import type { PageId } from '../navigation'

interface TutorialStep {
  title: string
  body: ReactNode
}

type TutorialDestination = PageId | 'account-center'

interface TutorialSection {
  id: string
  title: string
  summary: string
  keywords: string
  icon: LucideIcon
  steps: TutorialStep[]
  destination?: TutorialDestination
  destinationLabel?: string
}

const TUTORIAL_SECTIONS: readonly TutorialSection[] = [
  {
    id: 'start',
    title: '首次使用',
    summary: '从登录到完成第一个 AI 工具配置。',
    keywords: '欢迎 注册 登录 记住密码 自动登录 余额',
    icon: Download,
    destination: 'overview',
    destinationLabel: '打开工具概览',
    steps: [
      { title: '1. 登录星芒账号', body: '启动后使用邮箱或用户名登录。可选“记住密码”和“自动登录”；会话与凭据由系统安全存储保护。' },
      { title: '2. 等待首次检测', body: '工具箱会检测 Node.js、npm、四个 CLI 与 Codex 桌面端。“检测失败”不等于“未安装”，先使用重新检测或健康诊断。' },
      { title: '3. 配置星芒 Key', body: '登录后工具箱会为已安装的 CLI 准备对应分组 Key。已经存在的 Key 会复用，不会每次启动都重复创建。' },
    ],
  },
  {
    id: 'install',
    title: '自动安装与更新',
    summary: '复用现有环境，只安装缺失项。',
    keywords: 'node npm claude codex gemini grok 安装 更新 PATH 权限 管理员 镜像',
    icon: Wrench,
    destination: 'maintenance',
    destinationLabel: '打开安装维护',
    steps: [
      { title: '一键准备', body: '工具概览中的安装操作会先复检本机环境。Node.js 20 或更高版本且 npm 可用时，不会重复下载 Node.js。' },
      { title: '单独安装或更新', body: '在“安装维护”中可单独处理 Claude Code、Codex CLI、Gemini CLI、Grok CLI 和 Codex 桌面端。进度与错误会在当前页显示。' },
      { title: '安装后仍未识别', body: '先点击“重新检测”。若终端中可运行而软件内不可用，打开健康诊断查看命令路径、npm 入口与权限模式，然后将诊断包提供给售后。' },
    ],
  },
  {
    id: 'account',
    title: '账户、充值与 Key',
    summary: '在客户端内查看余额、用量、订单和 API Key。',
    keywords: '账户 充值 支付 支付宝 订单 兑换码 订阅 邀请 余额 key apikey 分组 倍率',
    icon: Wallet,
    destination: 'account-center',
    destinationLabel: '打开个人中心',
    steps: [
      { title: '余额与用量', body: '主界面左下角显示当前余额。进入个人中心可按记录查看模型、token 和费用。' },
      { title: '充值与订阅', body: '支付方式、最低金额、折扣和订阅方案由星芒服务器返回。下单后在受控支付窗口完成付款，订单到账后余额自动刷新。' },
      { title: 'API Key 管理', body: '可新建、编辑、切换分组、查看倍率、复制或短时显示完整 Key。撤销 Key 会让所有使用它的 CLI 和画布请求立即失效。' },
    ],
  },
  {
    id: 'cli-config',
    title: 'CLI 配置与模型',
    summary: '选择账户 Key、分组和模型，再写入本地 CLI。',
    keywords: 'base url 模型 检测 配置 claude codex gemini grok key 分组',
    icon: KeyRound,
    destination: 'overview',
    destinationLabel: '返回工具概览',
    steps: [
      { title: '选择账户 Key', body: '已登录时，配置对话框可从账户内已有 Key 选择。所需分组没有 Key 时，工具箱会先提示并自动创建。' },
      { title: '检测与切换模型', body: '模型列表使用所选 Key 从星芒 API 读取。切换 Key 或分组后重新检测，不会沿用旧 Key 的模型结果。' },
      { title: '保存范围', body: '“只更新 Key/模型”保留其他原生配置；“重置为星芒初始配置”会覆盖对应工具的相关项。保存前会创建可恢复备份。' },
    ],
  },
  {
    id: 'chat-canvas',
    title: 'AI 聊天与无限画布',
    summary: '使用同一账户分组进行对话、生图、图像编辑和视频工作流。',
    keywords: 'ai 聊天 游乐场 无限画布 项目 节点 生图 视频 音频 素材 保存',
    icon: Bot,
    destination: 'chat',
    destinationLabel: '打开 AI 聊天',
    steps: [
      { title: 'AI 聊天', body: '选择分组、Key 和模型后开始对话。生成的图片会保存到本地 output 目录，可在素材菜单中定位。' },
      { title: '画布项目', body: '首次进入无限画布时新建或选择项目工作文件夹。节点、连线、布局、上游参考和已采纳结果会自动保存。' },
      { title: '本地素材', body: '图片、视频和音频可从文件夹拖入或从素材面板选择。同一项目中相同内容会按指纹复用，避免素材列表重复。' },
    ],
  },
  {
    id: 'backup',
    title: '备份、更新与安全',
    summary: '恢复配置、保持工具箱更新，并了解本地数据边界。',
    keywords: '备份 恢复 更新 安全 隐私 账号 密码 令牌 诊断',
    icon: ShieldCheck,
    destination: 'backups',
    destinationLabel: '打开配置备份',
    steps: [
      { title: '配置备份', body: '重要配置写入前会自动备份。在“配置备份”中预览内容后再恢复，恢复前还会保留当前版本。' },
      { title: '主程序更新', body: '打包版会定期检查新版本。下载后校验摘要与签名，通过后才会安装；开发版禁止替换自身。' },
      { title: '账号与本地数据', body: '账号令牌与记住的密码使用操作系统安全存储加密。API Key 只在明确复制、显示或写入 CLI 配置时解密。' },
    ],
  },
  {
    id: 'troubleshooting',
    title: '故障排查',
    summary: '先重新检测，再使用健康诊断和售后诊断包。',
    keywords: '失败 卡住 报错 网络 代理 权限 诊断 日志 售后',
    icon: CircleHelp,
    destination: 'health',
    destinationLabel: '打开健康诊断',
    steps: [
      { title: '检测失败', body: '不要立即重装。先重新检测，确认实际命令路径与版本；刚安装的环境可能需要重启工具箱以读取新 PATH。' },
      { title: '网络与代理', body: '先在健康诊断中测试星芒 API 和安装源。工具箱不锁定某一个代理网段；未开代理时仍使用系统正常网络。' },
      { title: '联系售后', body: '在“反馈与诊断”中生成诊断包，请先检查脱敏预览，再通过本页下方的企业微信入口联系售后。' },
    ],
  },
]

export function filterTutorialSections(query: string): readonly TutorialSection[] {
  const normalized = query.trim().toLocaleLowerCase('zh-CN')
  if (!normalized) return TUTORIAL_SECTIONS
  const terms = normalized.split(/\s+/u).filter(Boolean)
  return TUTORIAL_SECTIONS.filter((section) => {
    const searchable = `${section.title} ${section.summary} ${section.keywords} ${section.steps.map((step) => `${step.title} ${String(step.body)}`).join(' ')}`
      .toLocaleLowerCase('zh-CN')
    return terms.every((term) => searchable.includes(term))
  })
}

export function TutorialPage({
  onNavigate,
  onOpenSupport,
  onOpenAccountCenter,
}: {
  onNavigate: (pageId: PageId) => void
  onOpenSupport: () => void
  onOpenAccountCenter: () => void
}) {
  const [query, setQuery] = useState('')
  const [activeSectionId, setActiveSectionId] = useState(TUTORIAL_SECTIONS[0].id)
  const sections = useMemo(() => filterTutorialSections(query), [query])
  const activeSection = sections.find((section) => section.id === activeSectionId) ?? sections[0]

  return (
    <div className="tutorial-page">
      <header className="page-header tutorial-header">
        <div>
          <div className="eyebrow">GUIDE &amp; SUPPORT</div>
          <h1>使用教程</h1>
          <p>与当前版本同步的离线指南</p>
        </div>
        <button type="button" className="secondary-button" onClick={onOpenSupport}>
          <LifeBuoy size={16} />
          联系售后
          <ExternalLink size={14} />
        </button>
      </header>

      <div className="tutorial-search" role="search">
        <Search size={17} aria-hidden="true" />
        <input
          type="search"
          value={query}
          placeholder="搜索安装、充值、Key、画布或故障…"
          aria-label="搜索教程"
          onChange={(event) => setQuery(event.target.value)}
        />
        {query && <span aria-live="polite">{sections.length} 个主题</span>}
      </div>

      {activeSection ? (
        <div className="tutorial-layout">
          <nav className="tutorial-toc" aria-label="教程目录">
            {sections.map((section) => {
              const Icon = section.icon
              return (
                <button
                  key={section.id}
                  type="button"
                  className={section.id === activeSection.id ? 'active' : ''}
                  aria-current={section.id === activeSection.id ? 'page' : undefined}
                  onClick={() => setActiveSectionId(section.id)}
                >
                  <Icon size={16} />
                  <span>{section.title}</span>
                </button>
              )
            })}
          </nav>

          <article className="tutorial-article">
            <header>
              <div className="tutorial-article-icon"><activeSection.icon size={21} /></div>
              <div>
                <h2>{activeSection.title}</h2>
                <p>{activeSection.summary}</p>
              </div>
            </header>
            <div className="tutorial-steps">
              {activeSection.steps.map((step) => (
                <section key={step.title}>
                  <h3>{step.title}</h3>
                  <p>{step.body}</p>
                </section>
              ))}
            </div>
            {activeSection.destination && (
              <button
                type="button"
                className="primary-button tutorial-destination"
                onClick={() => {
                  if (activeSection.destination === 'account-center') onOpenAccountCenter()
                  else onNavigate(activeSection.destination as PageId)
                }}
              >
                {activeSection.destination === 'maintenance' ? <Wrench size={16} /> : null}
                {activeSection.destination === 'backups' ? <ArchiveRestore size={16} /> : null}
                {activeSection.destination === 'chat' ? <Bot size={16} /> : null}
                {activeSection.destination === 'settings' ? <Settings size={16} /> : null}
                {activeSection.destination === 'overview' ? <Gauge size={16} /> : null}
                {activeSection.destination === 'health' ? <ShieldCheck size={16} /> : null}
                {activeSection.destination === 'account-center' ? <UserRound size={16} /> : null}
                {activeSection.destinationLabel}
              </button>
            )}
          </article>
        </div>
      ) : (
        <section className="tutorial-empty">
          <CircleHelp size={24} />
          <h2>没找到相关教程</h2>
          <p>可尝试搜索“安装”、“充值”、“Key”或“画布”。</p>
          <button type="button" className="secondary-button" onClick={() => setQuery('')}>清除搜索</button>
        </section>
      )}

      <footer className="tutorial-support-band">
        <div>
          <LifeBuoy size={20} />
          <span><strong>需要人工帮助？</strong>联系星芒 AI 企业微信售后</span>
        </div>
        <button type="button" className="secondary-button" onClick={onOpenSupport}>
          打开售后会话 <ExternalLink size={14} />
        </button>
      </footer>
    </div>
  )
}
