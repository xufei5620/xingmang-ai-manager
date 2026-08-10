import { useEffect, useState } from 'react'
import {
  ArrowRight,
  BookOpen,
  Check,
  CheckCircle2,
  CircleDot,
  Download,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  X,
} from 'lucide-react'
import { DialogBackdrop } from '../Dialog'
import { nodeRuntimeSupported } from '../../onboarding-runtime'
import { platformPresentation } from '../../platform-presentation'
import type {
  CodexSetupStatus,
  NodeRuntimeInstallProgress,
  PlatformCapabilities,
} from '../../types'

export function NodeInstallGuide({
  runtime,
  busy,
  scanning = false,
  installProgress,
  onClose,
  onInstall,
  onRecheck,
  platform,
}: {
  runtime: CodexSetupStatus['runtime'] | null
  busy: boolean
  scanning?: boolean
  installProgress: NodeRuntimeInstallProgress | null
  onClose: () => void
  onInstall: () => void
  onRecheck: () => void
  platform: PlatformCapabilities
}) {
  const presentation = platformPresentation(platform)
  const [step, setStep] = useState(0)
  const steps = [
    {
      title: '下载 Node.js LTS',
      description: presentation.nodeGuideDescription,
      content: (
        <div className="node-guide-download-actions">
          <button type="button" className="primary-button node-guide-download" disabled={busy} onClick={onInstall}>
            {busy ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}
            {busy ? '正在自动安装' : presentation.nodeActionLabel}
          </button>
          <button
            type="button"
            className="secondary-button node-guide-download"
            disabled={busy}
            onClick={() => void window.xingmang.openExternal('https://nodejs.org/')}
          >
            官网手动下载
            <ExternalLink size={14} />
          </button>
        </div>
      ),
    },
    {
      title: '安装 Node.js 和 npm',
      description: presentation.nodeGuideInstallDescription,
      content: (
        <div className="node-guide-checks">
          <span><CheckCircle2 size={15} />Node.js runtime</span>
          <span><CheckCircle2 size={15} />npm package manager</span>
        </div>
      ),
    },
    {
      title: presentation.nodeGuidePathTitle,
      description: presentation.nodeGuidePathDescription,
      content: (
        <div className="node-guide-path">
          <CheckCircle2 size={16} />
          <div>
            <strong>{presentation.nodeGuidePathLabel}</strong>
            <span>{presentation.nodeGuidePathDetail}</span>
          </div>
        </div>
      ),
    },
    {
      title: '完成安装并重新检测',
      description: presentation.nodeGuideFinishDescription,
      content: (
        <div className="node-guide-status">
          <span className={runtime && nodeRuntimeSupported(runtime) ? 'ready' : ''}>
            {runtime && nodeRuntimeSupported(runtime) ? <Check size={14} /> : <CircleDot size={14} />}
            Node.js {runtime?.node.tooOld ? '版本过低' : runtime?.node.installed ? '已识别' : '等待检测'}
          </span>
          <span className={runtime?.npm.installed ? 'ready' : ''}>
            {runtime?.npm.installed ? <Check size={14} /> : <CircleDot size={14} />}
            npm {runtime?.npm.installed ? '已识别' : '等待检测'}
          </span>
          {runtime !== null && !runtime.node.installed && (
            <p className="node-guide-restart-hint">
              如果你刚在本软件之外安装完 Node.js，仍检测不到属正常现象——已运行的程序
              读不到新的系统 PATH。请关闭并重新打开本软件后再检测。
            </p>
          )}
        </div>
      ),
    },
  ] as const
  const current = steps[step]

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [busy, onClose])

  return (
    <DialogBackdrop className="save-mode-backdrop onboarding-guide-backdrop" onDismiss={busy ? () => undefined : onClose}>
      <section className="onboarding-guide-dialog" role="dialog" aria-modal="true" aria-labelledby="node-guide-title">
        <header className="onboarding-guide-head">
          <div className="onboarding-guide-title">
            <span><BookOpen size={19} /></span>
            <div>
              <h2 id="node-guide-title">Node.js 安装教程</h2>
              <p>按下面 4 步完成 Codex CLI 前置环境。</p>
            </div>
          </div>
          <button type="button" className="icon-button" title="关闭教程" aria-label="关闭教程" disabled={busy} onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="node-guide-steps" aria-label="Node.js 安装步骤">
          {steps.map((item, index) => (
            <button
              type="button"
              key={item.title}
              className={index === step ? 'active' : index < step ? 'complete' : ''}
              aria-label={`第 ${index + 1} 步：${item.title}`}
              onClick={() => setStep(index)}
            >
              {index < step ? <Check size={13} strokeWidth={3} /> : index + 1}
            </button>
          ))}
        </div>

        <div className="node-guide-content" aria-live="polite">
          <span>第 {step + 1} 步</span>
          <h3>{current.title}</h3>
          <p>{current.description}</p>
          {current.content}
          {installProgress && busy && (
            <div className={`node-guide-install-progress phase-${installProgress.phase}`}>
              <div>
                <span>{installProgress.message}</span>
                {installProgress.percent !== null && <strong>{Math.round(installProgress.percent)}%</strong>}
              </div>
              <progress max="100" value={installProgress.percent ?? undefined} />
            </div>
          )}
        </div>

        <footer className="onboarding-guide-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={step === 0 || busy}
            onClick={() => setStep((value) => Math.max(0, value - 1))}
          >
            上一步
          </button>
          {step < steps.length - 1 ? (
            <button type="button" className="primary-button" onClick={() => setStep((value) => Math.min(steps.length - 1, value + 1))}>
              下一步 <ArrowRight size={16} />
            </button>
          ) : (
            <button type="button" className="primary-button" disabled={busy || scanning} onClick={onRecheck}>
              <RefreshCw size={16} className={busy || scanning ? 'spin' : ''} />
              {busy || scanning ? '正在检测' : '完成并重新检测'}
            </button>
          )}
        </footer>
      </section>
    </DialogBackdrop>
  )
}
