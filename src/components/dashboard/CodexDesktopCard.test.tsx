import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { platformCapabilitiesFor } from '../../../electron/platform-capabilities'
import { CodexDesktopCard } from './CodexDesktopCard'

describe('CodexDesktopCard update presentation', () => {
  it('shows mirror synchronization when a newer published build is not downloadable domestically yet', () => {
    const markup = renderToStaticMarkup(
      <CodexDesktopCard
        platform={platformCapabilitiesFor('win32', 'x64')}
        status={{
          installed: true,
          version: '26.803.5235.0',
          appVersion: '26.803.5235',
          mirrorVersion: '26.803.5235.0',
          mirrorUpdateAvailable: false,
          mirrorError: null,
          path: 'OpenAI.Codex_2p2nqsd0c76g0!App',
          installDirectory: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.803.5235.0_x64__2p2nqsd0c76g0',
          running: false,
          latestVersion: '26.803.10989.0',
          updateAvailable: true,
          updateSource: 'official-manifest',
          updateCheck: 'checked',
          updateState: 'available',
          updateCheckedAt: '2026-08-11T00:00:00.000Z',
          updateError: null,
        }}
        configured
        configExists
        model="gpt-5.6-sol"
        scanning={false}
        launchPhase="idle"
        installing={false}
        installProgress={null}
        onConfigure={vi.fn()}
        onInstall={vi.fn()}
        onLaunch={vi.fn()}
        onRetry={vi.fn()}
      />,
    )

    expect(markup).toContain('可更新至 26.803.10989.0 · 国内镜像同步中')
    expect(markup).toContain('查看更新')
    expect(markup).not.toContain('已检查，当前最新')
  })
})
