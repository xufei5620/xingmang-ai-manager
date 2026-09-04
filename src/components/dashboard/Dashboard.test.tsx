import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { EmptyStatus } from '../../app-shared'
import { platformCapabilitiesFor } from '../../../electron/platform-capabilities'
import { Dashboard } from './Dashboard'

describe('Dashboard structure', () => {
  it('exposes labelled sections and stable install-state hooks for the shell and smoke tests', () => {
    const markup = renderToStaticMarkup(
      <Dashboard
        platform={platformCapabilitiesFor('win32', 'x64')}
        snapshot={EmptyStatus()}
        config={null}
        scanning={false}
        installing={new Set()}
        cliLaunching={null}
        codexLaunchPhase="idle"
        codexDesktopInstalling={false}
        codexDesktopInstallProgress={null}
        nodeRuntimeInstalling={false}
        nodeRuntimeInstallProgress={null}
        pythonRuntimeInstalling={false}
        pythonRuntimeInstallProgress={null}
        runtimeReady={false}
        installedCliCount={0}
        installedToolCount={0}
        nextStepsNudge={{ triedLaunch: false, exploredMcp: false }}
        onScan={vi.fn()}
        onInstallNode={vi.fn()}
        onInstallPython={vi.fn()}
        onOpenNodeGuide={vi.fn()}
        onInstall={vi.fn()}
        onInstallAll={vi.fn()}
        onConfigure={vi.fn()}
        onConfigureCodexDesktop={vi.fn()}
        onInstallCodexDesktop={vi.fn()}
        onLaunch={vi.fn()}
        onLaunchCodexDesktop={vi.fn()}
        onNextStepsConfigureFirstCli={vi.fn()}
        onNextStepsTryLaunch={vi.fn()}
        onNextStepsGoMaintenance={vi.fn()}
        onNextStepsExploreMcp={vi.fn()}
      />,
    )

    expect(markup).toContain('data-dashboard-section="runtime"')
    expect(markup).toContain('aria-labelledby="dashboard-runtime-heading"')
    expect(markup).toContain('data-dashboard-section="tools"')
    expect(markup).toContain('aria-labelledby="dashboard-tools-heading"')
    expect(markup.match(/data-provider-id=/g)).toHaveLength(5)
    expect(markup).toContain('data-provider-id="codex-desktop"')
    expect(markup).toContain('data-install-state="missing"')
  })
})
