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

  it('adds the download page only after a failure, and skips the Windows prompt hint on a Mac', () => {
    const html = renderToStaticMarkup(<RequiredUpdateGate update={snapshot({ phase: 'error', error: { code: 'X', message: '网络断了' } })} windows={false} actions={actions} />)
    expect(html).toContain('更新没有完成：网络断了')
    expect(html).toContain('data-testid="required-update-download-page"')
    expect(html).not.toContain('是否允许更改')
  })
})
