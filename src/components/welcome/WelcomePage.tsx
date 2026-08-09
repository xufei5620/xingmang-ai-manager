import { useState } from 'react'
import { ArrowRight, ChevronDown, PackageCheck, QrCode, Sparkles, Target } from 'lucide-react'
import logoUrl from '../../../assets/icon.png'
import logoWhiteUrl from '../../../assets/icon-white.png'
import type { ThemeMode } from '../../app-shared'
import { providers } from '../../provider-meta'
import type { ProviderId } from '../../types'

interface ConstellationNode {
  id: ProviderId
  label: string
  position: 'top' | 'right' | 'bottom' | 'left'
}

// Node order/labels mirror the finalized mockup (docs/mockups/welcome-draft.html)
// verbatim; only the dot color is sourced live from provider-meta.ts instead of
// being copied as a literal hex, so it can never drift from the real brand color.
//
// 星图是固定的四方位（上/右/下/左）视觉布局，故意不从 provider-registry 派生
// provider 集合：新增第 5 个 provider 时这四个方位本就要重新设计，派生反而会
// 在布局撑不下时静默错位，硬编码在这里是有意为之。
const constellationNodes: ConstellationNode[] = [
  { id: 'claude', label: 'Claude Code', position: 'top' },
  { id: 'codex', label: 'Codex', position: 'right' },
  { id: 'gemini', label: 'Gemini', position: 'bottom' },
  { id: 'grok', label: 'Grok', position: 'left' },
]

const assuranceEvidence = [
  {
    tag: '01 / 直连',
    title: '直连原厂接口',
    body: '请求转发到各家官方模型接口，不做套壳替换，也不改写你的提示词。',
  },
  {
    tag: '02 / 不降级',
    title: '你选哪个，跑哪个',
    body: '选定的模型就是实际运行的，不会在后台悄悄换成更小的模型来省成本。',
  },
  {
    tag: '03 / 可核对',
    title: '用量算得清',
    body: '每次调用按量计费，余额与消耗明细随时可查，账目自己就能对得上。',
  },
]

const heroCards = [
  {
    Icon: PackageCheck,
    title: '不碰命令行，一键装好',
    body: '环境、CLI、配置全自动搞定；安装失败自动回滚，不会留下半装的坏状态。',
  },
  {
    Icon: Target,
    title: '原厂模型直连',
    body: '直接对接各家官方模型接口，不套壳、不偷偷降级。用量与计费透明，随时可查。',
  },
  {
    Icon: Sparkles,
    title: '一个账号，四家通用',
    body: '注册即自动开好 API Key，四家 CLI 共用一套额度，不必再各处申请、逐个填配置。',
  },
]

export function WelcomePage({
  theme,
  onRegister,
  onHaveCode,
  onLogin,
}: {
  theme: ThemeMode
  onRegister: () => void
  onHaveCode: () => void
  onLogin: () => void
}) {
  const [assureOpen, setAssureOpen] = useState(false)

  return (
    <div className="welcome-page">
      <div className="welcome-content">
        <header className="welcome-nav">
          <div className="welcome-brand">
            <img src={theme === 'dark' ? logoWhiteUrl : logoUrl} className="welcome-brand-logo" alt="星芒AI" />
            <span className="welcome-brand-name"><span>星芒</span>AI</span>
          </div>
          <button type="button" className="welcome-nav-login" onClick={onLogin}>已有账号？登录</button>
        </header>

        <div className="welcome-hero">
          <div className="welcome-hero-copy">
            <span className="welcome-eyebrow">一个账号 · 通用四家 CLI</span>
            <h1 className="welcome-title">装好即用的<br />AI 编程工具箱</h1>
            <p className="welcome-sub">
              不用装 Node、不用敲 npm、不用手改配置文件。Claude Code、Codex、Gemini、Grok 四家 CLI，图形化装好、统一管理。
            </p>

            <div className="welcome-cta-row">
              <button type="button" className="welcome-cta-primary" onClick={onRegister}>
                免费注册，领试用额度
                <span className="welcome-cta-arrow" aria-hidden="true"><ArrowRight size={16} /></span>
              </button>
              <div className="welcome-cta-alt">
                <button type="button" className="welcome-cta-ghost" onClick={onHaveCode}>我有授权码</button>
                <span className="welcome-cta-note">新用户直接注册即可</span>
              </div>
            </div>

            <div className="welcome-chips">
              <span className="welcome-chip">邮箱注册 · 约 1 分钟</span>
              <span className="welcome-chip">国内直连 · 无需额外工具</span>
              <span className="welcome-chip">按量计费 · 价格厚道</span>
            </div>

            {/* 覆盖层浮卡：绝对定位，展开态不挤压布局、不产生滚动条（单屏硬约束） */}
            <div className={`welcome-assure${assureOpen ? ' open' : ''}`}>
              <button
                type="button"
                className="welcome-assure-toggle"
                aria-expanded={assureOpen}
                aria-controls="welcome-assure-panel"
                onClick={() => setAssureOpen((current) => !current)}
              >
                <span className="welcome-assure-toggle-label">我们如何保证原厂模型？</span>
                <ChevronDown size={14} className="welcome-assure-chev" aria-hidden="true" />
              </button>
              <div
                className="welcome-assure-panel"
                id="welcome-assure-panel"
                role="region"
                aria-label="如何保证原厂模型"
              >
                <p className="welcome-assure-title">三条一眼看清</p>
                <div className="welcome-assure-grid">
                  {assuranceEvidence.map((item) => (
                    <div className="welcome-assure-card" key={item.tag}>
                      <span className="welcome-assure-tag">{item.tag}</span>
                      <strong>{item.title}</strong>
                      <span className="welcome-assure-desc">{item.body}</span>
                    </div>
                  ))}
                </div>
                <p className="welcome-assure-note">
                  <strong>说明：</strong>
                  请求经星芒中转直达各家原厂接口；星芒本机只把 API Key 写进各 CLI 的配置文件，不额外留存明文副本。
                </p>
              </div>
            </div>
          </div>

          <div className="welcome-hero-visual">
            <div className="welcome-constellation">
              <svg viewBox="0 0 400 400" aria-hidden="true">
                <circle className="welcome-ring" cx="200" cy="200" r="96" />
                <circle className="welcome-ring" cx="200" cy="200" r="150" />
                <line className="welcome-spoke" x1="200" y1="200" x2="200" y2="60" />
                <line className="welcome-spoke" x1="200" y1="200" x2="340" y2="200" />
                <line className="welcome-spoke" x1="200" y1="200" x2="200" y2="340" />
                <line className="welcome-spoke" x1="200" y1="200" x2="60" y2="200" />
                <line className="welcome-ray" x1="200" y1="200" x2="296" y2="104" />
                <line className="welcome-ray" x1="200" y1="200" x2="296" y2="296" />
                <line className="welcome-ray" x1="200" y1="200" x2="104" y2="296" />
                <line className="welcome-ray" x1="200" y1="200" x2="104" y2="104" />
              </svg>
              <div className="welcome-star-core">
                <Sparkles size={22} aria-hidden="true" />
                <span className="welcome-star-core-lbl">星芒账号</span>
                <span className="welcome-star-core-sub">一套 Key</span>
              </div>
              {constellationNodes.map((node) => (
                <div className={`welcome-node welcome-node-${node.position}`} key={node.id}>
                  <i style={{ background: providers[node.id].color }} aria-hidden="true" />
                  {node.label}
                </div>
              ))}
            </div>
            <p className="welcome-constell-cap">一个星芒账号，四家 CLI 共用一套额度</p>
          </div>
        </div>

        <div className="welcome-cards3">
          {heroCards.map((card) => (
            <div className="welcome-card" key={card.title}>
              <div className="welcome-card-icon"><card.Icon size={20} aria-hidden="true" /></div>
              <h3>{card.title}</h3>
              <p>{card.body}</p>
            </div>
          ))}
        </div>

        <footer className="welcome-foot">
          <div className="welcome-foot-left">
            <span>{`© ${new Date().getFullYear()} 星芒 AI`}</span>
            <span className="welcome-foot-dot">·</span>
            <span>用户协议</span>
            <span className="welcome-foot-dot">·</span>
            <span>隐私政策</span>
            <span className="welcome-foot-dot">·</span>
            <span>帮助文档</span>
            <span className="welcome-foot-dot">·</span>
            <span>账号后台 <code>xm.solov.cc</code></span>
          </div>
          <div className="welcome-cs">
            {/* TODO(素材待办): 企业微信客服二维码为占位图，等实际素材到位后替换 */}
            <div className="welcome-cs-qr" aria-hidden="true">
              <QrCode size={20} />
              <span className="welcome-cs-qr-todo">TODO</span>
            </div>
            <div className="welcome-cs-copy">
              <strong>企业微信 · 扫码联系客服</strong>
              <span>或在线联系客服</span>
              <span className="welcome-cs-note">占位图，待正式素材替换</span>
            </div>
          </div>
        </footer>
      </div>
    </div>
  )
}
