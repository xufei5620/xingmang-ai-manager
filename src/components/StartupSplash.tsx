import { LoaderCircle } from 'lucide-react'
import logoUrl from '../../assets/brand/v3/symbol-standard.svg'
import logoWhiteUrl from '../../assets/brand/v3/symbol-dark.svg'
import type { StartupStage, ThemeMode } from '../app-shared'
import type { UpdateSnapshot } from '../types'

function formatStartupBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

function startupUpdateLabel(state: UpdateSnapshot | null): string {
  if (state?.error) return `更新失败：${state.error.message}`
  if (state?.phase === 'available') return `发现新版本 ${state.availableVersion ?? ''}，准备下载`.trim()
  if (state?.phase === 'downloading') return `正在下载 ${state.availableVersion ?? '新版本'}`
  if (state?.phase === 'downloaded') return '更新下载完成，正在安装并重启'
  return '正在检查主程序更新'
}

export function StartupSplash({
  theme,
  stage,
  updateState,
}: {
  theme: ThemeMode
  stage: StartupStage
  updateState: UpdateSnapshot | null
}) {
  const progress = stage === 'updates' ? updateState?.progress ?? null : null
  return (
    <div className="startup-splash">
      <img src={theme === 'dark' ? logoWhiteUrl : logoUrl} alt="星芒AI" />
      <div className="startup-splash-copy">
        <strong>星芒 AI</strong>
        <span>{stage === 'updates' ? startupUpdateLabel(updateState) : '正在检测 Codex 配置'}</span>
        {progress && (
          <div className="startup-update-progress" aria-label="主程序更新下载进度">
            <div>
              <span style={{ width: `${progress.percent}%` }} />
            </div>
            <small>
              {progress.percent.toFixed(1)}%
              {' · '}{formatStartupBytes(progress.transferred)} / {formatStartupBytes(progress.total)}
              {' · '}{formatStartupBytes(progress.bytesPerSecond)}/s
            </small>
          </div>
        )}
      </div>
      <LoaderCircle size={20} className="spin" />
    </div>
  )
}
