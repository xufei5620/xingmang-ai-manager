import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { platformCapabilitiesFor } from '../../../electron/platform-capabilities'
import { CodexDesktopCard } from './CodexDesktopCard'

describe('CodexDesktopCard update presentation', () => {
  it('does not offer a sideload when the Store install is already at the mirror', () => {
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

    expect(markup).not.toContain('26.803.5235.0')
    expect(markup).toContain('26.803.5235')
    expect(markup).not.toContain('已是可安装最新版')
    expect(markup).not.toContain('查看更新')
    expect(markup).not.toContain('>安装最新版<')
    expect(markup).not.toContain('国内镜像同步中')
    expect(markup).toContain('data-provider-id="codex-desktop"')
    expect(markup).toContain('data-install-state="installed"')
  })

  it('shows the shared Codex model and plan when ChatGPT is logged in without a Xingmang key', () => {
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
        }}
        configured={false}
        configExists
        officialLoggedIn
        officialAccountEmail="ivy@example.com"
        officialAccountPlan="Pro 5x"
        officialAccountRenewsAt="2026-09-22T11:32:00.000Z"
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

    expect(markup).toContain('gpt-5.6-sol')
    expect(markup).toContain('套餐 Pro 5x')
    expect(markup).toContain('续期')
    expect(markup).not.toContain('刷新额度')
  })

  it('offers a quota refresh only when the ChatGPT account handler is provided', () => {
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
        }}
        configured={false}
        configExists
        officialLoggedIn
        officialAccountEmail="ivy@example.com"
        officialAccountPlan="Pro 5x"
        model="gpt-5.6-sol"
        scanning={false}
        launchPhase="idle"
        installing={false}
        installProgress={null}
        onConfigure={vi.fn()}
        onInstall={vi.fn()}
        onLaunch={vi.fn()}
        onRetry={vi.fn()}
        onRefreshUsage={vi.fn()}
      />,
    )

    expect(markup).toContain('刷新额度')
  })
})
