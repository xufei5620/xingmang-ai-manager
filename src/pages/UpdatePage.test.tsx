import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { UpdateSnapshot } from '../types'
import { UpdatePage } from './UpdatePage'

const disabledSnapshot: UpdateSnapshot = {
  phase: 'disabled',
  currentVersion: '0.1.12',
  availableVersion: null,
  releaseName: null,
  releaseNotesText: null,
  checkedAt: null,
  progress: null,
  error: null,
  development: true,
}

describe('UpdatePage build-mode status', () => {
  it('distinguishes a local development package from the free distribution updater', () => {
    const markup = renderToStaticMarkup(
      <UpdatePage
        state={disabledSnapshot}
        busy={false}
        onCheck={vi.fn()}
        onDownload={vi.fn()}
        onInstall={vi.fn()}
      />,
    )

    expect(markup).toContain('本地开发包不检查更新')
    expect(markup).toContain('免费分发包会启用自动更新，需同步发布完整更新文件')
  })
})
