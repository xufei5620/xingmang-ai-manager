import { describe, expect, it } from 'vitest'
import { formatWaitedDuration, installProgressLabel } from './install-stage-text'

describe('installProgressLabel', () => {
  it('replaces staged main-process wording with plain sentences', () => {
    expect(installProgressLabel({ message: '正在从 npm 官方源校验推荐版本 2.1.277 和 SHA-512 完整性元数据', stage: 'version' })).toBe('正在确认安装版本…')
    expect(installProgressLabel({ message: '检测到中国大陆网络，正在通过国内 npm 镜像安装已校验版本 @anthropic-ai/claude-code@2.1.277', stage: 'download' })).toBe('正在下载，首次下载可能需要几分钟，请勿关闭窗口…')
    expect(installProgressLabel({ message: '国内 npm 镜像安装失败，正在切换npm 官方源 https://registry.npmjs.org/', stage: 'switch-route' })).toBe('当前下载线路不稳定，已切换线路继续安装…')
    expect(installProgressLabel({ message: '完整依赖图与官方 SHA-512 对账通过', stage: 'verify' })).toBe('正在校验下载文件的完整性…')
    expect(installProgressLabel({ message: 'x', stage: 'install' })).toBe('正在装到电脑上…')
    expect(installProgressLabel({ message: 'x', stage: 'final-check' })).toBe('安装完成，正在进行最终检查…')
  })

  it('turns a download heartbeat into a plain elapsed-time sentence', () => {
    expect(installProgressLabel({ message: '仍在解析国内 npm 镜像的依赖图…（已用时 1 分 20 秒）', stage: 'download', elapsedMs: 80_000 }))
      .toBe('仍在下载，已等待 1 分 20 秒。网络较慢时耗时会更长，请耐心等待。')
  })

  it('keeps raw npm output off the visible line', () => {
    expect(installProgressLabel({ message: 'npm warn deprecated inflight@1.0.6', stage: 'raw-output' })).toBeNull()
  })

  it('shows unstaged messages unchanged', () => {
    expect(installProgressLabel({ message: 'Claude Code 安装或更新完成（2.1.277）' })).toBe('Claude Code 安装或更新完成（2.1.277）')
  })

  it('never lets any staged sentence carry technical words', () => {
    const stages = ['version', 'download', 'switch-route', 'verify', 'install', 'final-check'] as const
    for (const stage of stages) {
      for (const elapsedMs of [undefined, 95_000]) {
        const label = installProgressLabel({ message: 'npm SHA-512 https://registry.npmjs.org/', stage, elapsedMs }) ?? ''
        expect(label).not.toMatch(/npm|SHA|http|镜像|依赖|@|registry/i)
      }
    }
  })
})

describe('formatWaitedDuration', () => {
  it('formats seconds and minutes in plain words', () => {
    expect(formatWaitedDuration(45_000)).toBe('45 秒')
    expect(formatWaitedDuration(120_000)).toBe('2 分钟')
    expect(formatWaitedDuration(80_400)).toBe('1 分 20 秒')
  })
})
