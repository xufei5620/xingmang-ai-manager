import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { UpdateSnapshot } from '../../../../electron/ipc-contract'
import { RequiredUpdateGate, type RequiredUpdateActions } from './RequiredUpdateGate'

const actions: RequiredUpdateActions = {
  check: async () => undefined,
  download: async () => undefined,
  install: () => undefined,
  openDownloadPage: () => undefined,
  contactSupport: () => undefined,
}

function snapshot(patch: Partial<UpdateSnapshot> = {}): UpdateSnapshot {
  return {
    phase: 'available',
    currentVersion: '0.2.12',
    availableVersion: '0.2.13',
    releaseName: null,
    releaseNotesText: null,
    checkedAt: null,
    progress: null,
    error: null,
    development: false,
    requiredVersion: '0.2.13',
    ...patch,
  }
}

describe('RequiredUpdateGate', () => {
  it('renders nothing when no update is required', () => {
    expect(renderToStaticMarkup(<RequiredUpdateGate update={snapshot({ requiredVersion: null })} windows actions={actions} />)).toBe('')
    expect(renderToStaticMarkup(<RequiredUpdateGate update={snapshot({ phase: 'not-available' })} windows actions={actions} />)).toBe('')
  })

  it('offers only updating and support, with no way to close it', () => {
    const html = renderToStaticMarkup(<RequiredUpdateGate update={snapshot()} windows actions={actions} />)
    expect(html).toContain('data-testid="required-update-gate"')
    expect(html).toContain('这个版本需要更新后才能继续用')
    expect(html).toContain('现在是 0.2.12，将更新到 0.2.13')
    expect(html).toContain('是否允许更改')
    expect(html).toContain('data-testid="required-update-start"')
    expect(html).toContain('data-testid="required-update-support"')
    expect(html).not.toContain('data-modal-close')
    expect(html).not.toContain('required-update-download-page')
  })

  it('shows how much has downloaded, how fast, and how long is left under the progress bar', () => {
    const progress = { percent: 50, bytesPerSecond: 1, transferred: 50 * 1024 ** 2, total: 100 * 1024 ** 2, averageBytesPerSecond: 2 * 1024 ** 2, secondsRemaining: 150 }
    const html = renderToStaticMarkup(<RequiredUpdateGate update={snapshot({ phase: 'downloading', progress })} windows actions={actions} />)
    expect(html).toContain('data-testid="required-update-progress"')
    expect(html).toContain('已下载 50 MB / 共 100 MB · 每秒 2 MB · 大约还要 3 分钟')
    expect(renderToStaticMarkup(<RequiredUpdateGate update={snapshot()} windows actions={actions} />)).not.toContain('required-update-progress-detail')
  })

  it('adds the download page only after a failure, and skips the Windows prompt hint on a Mac', () => {
    const html = renderToStaticMarkup(<RequiredUpdateGate update={snapshot({ phase: 'error', error: { code: 'X', message: '网络断了' } })} windows={false} actions={actions} />)
    expect(html).toContain('更新没有完成。</strong>网络断了')
    expect(html).not.toContain('更新没有完成：')
    expect(html).toContain('data-testid="required-update-download-page"')
    expect(html).not.toContain('是否允许更改')
  })

  it('names only the buttons the gate actually has when an install did not start', () => {
    const message = '新版本没装上：安装程序没起来，可能是 Windows 的授权窗口被关掉了。点「重新安装」再试一次，授权窗口弹出来时点「是」。'
    const html = renderToStaticMarkup(<RequiredUpdateGate update={snapshot({ phase: 'downloaded', failedStep: 'install', error: { code: 'UPDATE_INSTALL_LAUNCH_TIMEOUT', message } })} windows actions={actions} />)
    expect(html).toContain('安装更新失败。</strong>新版本没装上')
    // 原因句说「点「重新安装」」，门的主按钮就叫「重新安装」。
    expect(html).toMatch(/data-testid="required-update-start"[^>]*>(?:<[^>]+>)*重新安装/)
    // 门里没有「查看日志」，也到不了更新页。
    expect(html).not.toContain('查看日志')
    expect(html).not.toContain('「更新」页')
  })

  it('tells the user the disk is full, how much to free, and offers a retry and a download-anyway', () => {
    const html = renderToStaticMarkup(<RequiredUpdateGate update={snapshot({ diskShortfall: { neededBytes: 1800 * 1024 ** 2, freeBytes: 1200 * 1024 ** 2 } })} windows actions={actions} />)
    expect(html).toContain('data-testid="required-update-disk"')
    expect(html).toContain('磁盘空间不够，新版本还没开始下载。')
    expect(html).toContain('电脑磁盘只剩 1.2 GB，装更新大约要 1.8 GB，还要再清出 600 MB')
    expect(html).toContain('data-testid="required-update-disk-help"')
    expect(html).toContain('怎么清理')
    expect(html).toContain('data-testid="required-update-download-anyway"')
    expect(html).toContain('空间够了，再试一次')
    // 门里进不了更新页，不许叫他「回到更新页」，也不许说「会自动下载」让他干等。
    expect(html).not.toContain('回到更新页')
    expect(html).not.toContain('会自动下载')
    expect(html).not.toContain('required-update-download-page')
  })

  it('keeps the disk notice out of the normal gate', () => {
    const html = renderToStaticMarkup(<RequiredUpdateGate update={snapshot()} windows actions={actions} />)
    expect(html).not.toContain('required-update-disk')
    expect(html).not.toContain('required-update-download-anyway')
  })
})
