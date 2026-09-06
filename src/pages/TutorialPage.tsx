import { useMemo, type ReactNode } from 'react'
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
import { useNavigationState } from '../components/shell/NavigationState'
import './maintenance-v3.css'

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
    summary: '登录，装好第一个工具，就能开始用。',
    keywords: '欢迎 注册 登录 记住密码 自动登录 余额',
    icon: Download,
    destination: 'overview',
    destinationLabel: '打开首页',
    steps: [
      { title: '1. 登录星芒账号', body: '启动后用邮箱或用户名登录。可以勾选“记住密码”和“自动登录”。' },
      { title: '2. 选择一种开始方式', body: '从 Claude Code、Codex CLI、Codex 桌面端、Gemini CLI、Grok CLI 或直接聊天中选择。桌面端与聊天不要求 Node.js。检测失败时先重新检测，不要重复安装。' },
      { title: '3. 确认账号来源', body: '准备完成后检查星芒密钥或官方账号来源。已有第三方配置会保留，只有明确保存后才写入新的工具配置。' },
    ],
  },
  {
    id: 'install',
    title: '自动安装与更新',
    summary: '有的会复用，缺的才装。',
    keywords: 'node npm claude codex gemini grok 安装 更新 PATH 权限 管理员 镜像',
    icon: Wrench,
    destination: 'maintenance',
    destinationLabel: '打开安装卸载',
    steps: [
      { title: '一键准备', body: '首页点安装时，会先再检查一遍本机。Node.js 20 以上且 npm 能用，就不会重复下载。' },
      { title: '单独安装或更新', body: '在「安装卸载」里可以单独处理 Claude、Codex、Gemini、Grok 和 Codex 桌面端。进度和报错都在这一页。' },
      { title: '装好了软件还不认', body: '先点“重新检测”。终端里能用、软件里不行，就去「检查」看路径和权限，再把报告发给我们。' },
    ],
  },
  {
    id: 'account',
    title: '账户、充值与 Key',
    summary: '看余额、充值、订单和密钥。',
    keywords: '账户 充值 支付 支付宝 订单 兑换码 订阅 邀请 余额 key apikey 分组 倍率',
    icon: Wallet,
    destination: 'account-center',
    destinationLabel: '打开个人中心',
    steps: [
      { title: '余额与用量', body: '左下角就能看到余额。点进去能看每次调用花了多少。' },
      { title: '充值与订阅', body: '付款方式和最低金额由服务器决定。下单后在弹出的窗口里付钱，到账后余额会自己刷新。' },
      { title: '管理密钥', body: '可以新建、改分组、复制或短暂显示完整 Key。撤销后，用这把 Key 的工具会立刻连不上。' },
    ],
  },
  {
    id: 'cli-config',
    title: '工具配置与模型',
    summary: '选好 Key、分组和模型，再写进本地工具。',
    keywords: 'base url 模型 检测 配置 claude codex gemini grok key 分组',
    icon: KeyRound,
    destination: 'overview',
    destinationLabel: '返回首页',
    steps: [
      { title: '选择账户 Key', body: '已登录时，配置窗口可以从账户里已有的 Key 里选。这个分组还没有 Key，软件会先提示并自动创建。' },
      { title: '检测与切换模型', body: '模型列表用当前这把 Key 去拉。换了 Key 或分组要重新检测，不会沿用上一把的结果。' },
      { title: '保存范围', body: '“只更新 Key/模型”会留下其他原有设置；“重置为星芒初始配置”会覆盖这个工具相关项。保存前会自动备份。' },
    ],
  },
  {
    id: 'chat-canvas',
    title: '聊天与画布',
    summary: '同一个账号，既能聊天生图，也能拼工作流。',
    keywords: 'ai 聊天 游乐场 无限画布 项目 节点 生图 视频 音频 素材 保存',
    icon: Bot,
    destination: 'chat',
    destinationLabel: '打开聊天',
    steps: [
      { title: '聊天', body: '选好分组和模型就能问。生成的图片会存到本机，可在素材菜单里找到。' },
      { title: '画布项目', body: '第一次打开画布时，选一个项目文件夹。节点、连线和结果会自动保存。' },
      { title: '本地素材', body: '图片、视频、音频可以从文件夹拖进来。同一项目里相同内容不会重复占地方。' },
    ],
  },
  {
    id: 'backup',
    title: '备份、更新与安全',
    summary: '配错了能恢复，软件也能升级。',
    keywords: '备份 恢复 更新 安全 隐私 账号 密码 令牌 诊断',
    icon: ShieldCheck,
    destination: 'backups',
    destinationLabel: '打开备份',
    steps: [
      { title: '备份', body: '改重要配置前会自动备份。在「备份」里先预览再恢复，恢复前还会再留一份当前版本。' },
      { title: '软件更新', body: '安装包会定期检查新版本。下载后校验通过才会安装。开发版不会自己替换自己。' },
      { title: '账号与本地数据', body: '登录状态和记住的密码由系统加密保存。密钥只在你复制、显示或写入工具配置时才会解密。' },
    ],
  },
  {
    id: 'troubleshooting',
    title: '出问题怎么办',
    summary: '先重新检测，再去做检查，还不行把报告发给我们。',
    keywords: '失败 卡住 报错 网络 代理 权限 诊断 日志 售后',
    icon: CircleHelp,
    destination: 'health',
    destinationLabel: '打开检查',
    steps: [
      { title: '检测失败', body: '先别重装。点重新检测，看实际路径和版本。刚装好的环境，可能要重启软件才能认到。' },
      { title: '网络与代理', body: '先去「检查」测一下星芒接口和下载源。没开代理就走系统网络。' },
      { title: '联系售后', body: '在「反馈」先预览脱敏报告，再复制或导出当前这份报告。报告不会自动发送，通过企业微信发送前请再次确认内容。' },
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
  const [query, setQuery] = useNavigationState('tutorial.query', '')
  const [activeSectionId, setActiveSectionId] = useNavigationState('tutorial.section', TUTORIAL_SECTIONS[0].id)
  const sections = useMemo(() => filterTutorialSections(query), [query])
  const activeSection = sections.find((section) => section.id === activeSectionId) ?? sections[0]

  return (
    <div className="page tutorial-page maintenance-v3 tutorial-v3" data-page-id="tutorial">
      <header className="page-header tutorial-header">
        <div>
          <h1>教程</h1>
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
          <span><strong>还是不会？</strong>加企业微信，我们帮你看</span>
        </div>
        <button type="button" className="secondary-button" onClick={onOpenSupport}>
          打开售后会话 <ExternalLink size={14} />
        </button>
      </footer>
    </div>
  )
}
