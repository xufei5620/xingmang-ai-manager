import { describe, expect, it } from 'vitest'
import type { CodexDesktopInstallProgress } from './codex-desktop-service'
import { codexDesktopProgressLogKey, withCodexDesktopProgressLog } from './system-service'

function recordingTarget() {
  const sent: Array<{ channel: string; payload: unknown }> = []
  let destroyed = false
  return {
    sent,
    destroy() {
      destroyed = true
    },
    target: {
      isDestroyed: () => destroyed,
      send: (channel: string, payload: unknown) => {
        sent.push({ channel, payload })
      },
    },
  }
}

describe('codexDesktopProgressLogKey', () => {
  it('treats ticks that only differ in numbers as the same step', () => {
    expect(codexDesktopProgressLogKey({ phase: 'downloading', percent: 12, message: '正在从国内镜像下载 Codex 桌面端 26.1007.1（12%）' }))
      .toBe(codexDesktopProgressLogKey({ phase: 'downloading', percent: 13, message: '正在从国内镜像下载 Codex 桌面端 26.1007.1（13%）' }))
  })

  it('keeps different steps and phases apart', () => {
    const download = codexDesktopProgressLogKey({ phase: 'downloading', percent: 0, message: '正在从国内镜像下载 Codex 桌面端 1.0（0%）' })
    expect(codexDesktopProgressLogKey({ phase: 'validating', percent: null, message: '正在检查下载下来的安装包是不是完整的官方版' })).not.toBe(download)
    expect(codexDesktopProgressLogKey({ phase: 'installing', percent: 0, message: '正在从国内镜像下载 Codex 桌面端 1.0（0%）' })).not.toBe(download)
  })
})

describe('withCodexDesktopProgressLog', () => {
  it('forwards every message and logs each step once', () => {
    const recording = recordingTarget()
    const logged: CodexDesktopInstallProgress[] = []
    const target = withCodexDesktopProgressLog(recording.target, (progress) => logged.push(progress))
    const steps: CodexDesktopInstallProgress[] = [
      { phase: 'downloading', percent: 0, message: '正在下载 Codex 桌面端 1.0（0%）' },
      { phase: 'downloading', percent: 40, message: '正在下载 Codex 桌面端 1.0（40%）' },
      { phase: 'validating', percent: null, message: '正在检查下载下来的安装包是不是完整的官方版' },
      { phase: 'completed', percent: 100, message: 'Codex 桌面端 1.0 装好了' },
    ]
    for (const step of steps) target.send('desktop:codex-install-progress', step)
    target.send('cli:install-progress', { provider: 'codex', state: 'output', message: 'other channel' })

    expect(recording.sent.map((entry) => entry.payload)).toEqual([...steps, { provider: 'codex', state: 'output', message: 'other channel' }])
    expect(logged.map((entry) => entry.message)).toEqual([
      '正在下载 Codex 桌面端 1.0（0%）',
      '正在检查下载下来的安装包是不是完整的官方版',
      'Codex 桌面端 1.0 装好了',
    ])
  })

  it('leaves the failure to the ipc error line so the error count is not doubled', () => {
    const recording = recordingTarget()
    const logged: CodexDesktopInstallProgress[] = []
    const target = withCodexDesktopProgressLog(recording.target, (progress) => logged.push(progress))
    target.send('desktop:codex-install-progress', { phase: 'error', percent: null, message: '安装失败' })

    expect(recording.sent).toHaveLength(1)
    expect(logged).toEqual([])
  })

  it('reports the wrapped target as destroyed once the window is gone', () => {
    const recording = recordingTarget()
    const target = withCodexDesktopProgressLog(recording.target, () => undefined)
    expect(target.isDestroyed()).toBe(false)
    recording.destroy()
    expect(target.isDestroyed()).toBe(true)
  })
})
