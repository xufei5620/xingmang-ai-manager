import { describe, expect, it, vi } from 'vitest'
import { platformCapabilitiesFor } from '../electron/platform-capabilities'
import type { AppConfigSummary, CodexSetupStatus, ToolStatus } from './types'
import {
  authorizeCodex,
  buildCodexDetectionFailureMessage,
  DEFAULT_CODEX_MODEL,
  installNodeAndPrepareCodexEnvironment,
  prepareCodexEnvironment,
  type CodexSetupApi,
  type CodexSetupCallbacks,
} from './onboarding-flow'

function tool(installed: boolean, version = installed ? 'test-version' : null): ToolStatus {
  return {
    installed,
    version,
    path: installed ? 'C:\\ProgramData\\XingMangAI\\tool.exe' : null,
    installDirectory: installed ? 'C:\\ProgramData\\XingMangAI' : null,
  }
}

// A probe that threw, distinct from one that concluded "not installed".
function failedTool(): ToolStatus {
  return {
    installed: false,
    version: null,
    path: null,
    installDirectory: null,
    detectionFailed: true,
    detectionError: '探测异常',
  }
}

function setupStatus(options: {
  node?: boolean
  npm?: boolean
  cli?: boolean
  desktop?: boolean
} = {}): CodexSetupStatus {
  const { node = true, npm = true, cli = true, desktop = true } = options
  return {
    checkedAt: '2026-07-25T00:00:00.000Z',
    runtime: { node: tool(node, node ? 'v22.17.0' : null), npm: tool(npm, npm ? '10.9.2' : null) },
    cli: tool(cli, cli ? '0.145.0' : null),
    desktop: {
      installed: desktop,
      version: desktop ? '26.721.4979.0' : null,
      appVersion: null,
      path: desktop ? 'C:\\Program Files\\WindowsApps\\OpenAI.Codex\\ChatGPT.exe' : null,
      installDirectory: desktop ? 'C:\\Program Files\\WindowsApps\\OpenAI.Codex' : null,
      mirrorVersion: null,
      mirrorUpdateAvailable: null,
      mirrorError: null,
      running: false,
      updateAvailable: false,
      latestVersion: null,
      updateState: 'unknown',
      updateError: null,
    },
  }
}

function callbacks() {
  return {
    value: {
      onAction: vi.fn(),
      onStatus: vi.fn(),
      onLog: vi.fn(),
    } satisfies CodexSetupCallbacks,
  }
}

describe('authorizeCodex', () => {
  const config = { workspace: 'C:\\work', providers: {} } as AppConfigSummary

  it('rejects an empty authorization code before making any API request', async () => {
    const api = {
      listModels: vi.fn(),
      saveConfig: vi.fn(),
      getConfig: vi.fn(),
    }

    await expect(authorizeCodex('   ', api)).rejects.toThrow('请填写安装授权码')
    expect(api.listModels).not.toHaveBeenCalled()
  })

  it('rejects an invalid key result without changing native configuration', async () => {
    const api = {
      listModels: vi.fn().mockResolvedValue([]),
      saveConfig: vi.fn(),
      getConfig: vi.fn(),
    }

    await expect(authorizeCodex('bad-key', api)).rejects.toThrow('没有返回可用模型')
    expect(api.saveConfig).not.toHaveBeenCalled()
    expect(api.getConfig).not.toHaveBeenCalled()
  })

  it('requires the onboarding default model before saving', async () => {
    const api = {
      listModels: vi.fn().mockResolvedValue(['gpt-5.6-terra']),
      saveConfig: vi.fn(),
      getConfig: vi.fn(),
    }

    await expect(authorizeCodex('sk-valid', api)).rejects.toThrow(DEFAULT_CODEX_MODEL)
    expect(api.saveConfig).not.toHaveBeenCalled()
  })

  it('trims a validated key, resets Codex configuration and returns the refreshed summary', async () => {
    const api = {
      listModels: vi.fn().mockResolvedValue([DEFAULT_CODEX_MODEL]),
      saveConfig: vi.fn().mockResolvedValue(undefined),
      getConfig: vi.fn().mockResolvedValue(config),
    }

    await expect(authorizeCodex('  sk-valid  ', api)).resolves.toBe(config)
    expect(api.listModels).toHaveBeenCalledWith('sk-valid')
    expect(api.saveConfig).toHaveBeenCalledWith({
      provider: 'codex',
      apiKey: 'sk-valid',
      model: DEFAULT_CODEX_MODEL,
      mode: 'reset',
    })
  })
})

describe('buildCodexDetectionFailureMessage', () => {
  it('returns null when every probe concluded normally, including a confirmed "not installed"', () => {
    expect(buildCodexDetectionFailureMessage(setupStatus())).toBeNull()
    expect(buildCodexDetectionFailureMessage(setupStatus({ cli: false }))).toBeNull()
  })

  it('names the single field whose detection failed', () => {
    const status: CodexSetupStatus = { ...setupStatus(), cli: failedTool() }
    expect(buildCodexDetectionFailureMessage(status)).toBe('Codex CLI暂时无法确认状态，请重试检测')
  })

  it('joins multiple failed fields in a fixed, readable order', () => {
    const base = setupStatus()
    const status: CodexSetupStatus = {
      ...base,
      runtime: { ...base.runtime, node: failedTool() },
      desktop: { ...base.desktop, installed: false, detectionFailed: true, detectionError: '桌面端探测超时' },
    }
    expect(buildCodexDetectionFailureMessage(status)).toBe('Node.js、Codex 桌面端暂时无法确认状态，请重试检测')
  })
})

describe('prepareCodexEnvironment', () => {
  it('returns a detection-failed outcome and never triggers an automatic install when a probe could not confirm status', async () => {
    const status: CodexSetupStatus = { ...setupStatus(), cli: failedTool() }
    const api: CodexSetupApi = {
      getCodexSetupStatus: vi.fn().mockResolvedValue(status),
      installCli: vi.fn(),
      installCodexDesktop: vi.fn(),
    }
    const listener = callbacks()

    const result = await prepareCodexEnvironment(api, listener.value)

    expect(result).toEqual({
      outcome: 'detection-failed',
      status,
      message: 'Codex CLI暂时无法确认状态，请重试检测',
    })
    expect(api.installCli).not.toHaveBeenCalled()
    expect(api.installCodexDesktop).not.toHaveBeenCalled()
    expect(listener.value.onAction).toHaveBeenLastCalledWith('idle')
  })

  it('reports a detection failure ahead of the runtime-required outcome it would otherwise produce', async () => {
    const base = setupStatus({ node: false, npm: false })
    const status: CodexSetupStatus = { ...base, runtime: { ...base.runtime, node: failedTool() } }
    const api: CodexSetupApi = {
      getCodexSetupStatus: vi.fn().mockResolvedValue(status),
      installCli: vi.fn(),
      installCodexDesktop: vi.fn(),
    }
    const listener = callbacks()

    await expect(prepareCodexEnvironment(api, listener.value)).resolves.toMatchObject({
      outcome: 'detection-failed',
    })
  })

  it('stops at the environment step when Node.js or npm is missing', async () => {
    const missingRuntime = setupStatus({ node: false, npm: false })
    const api: CodexSetupApi = {
      getCodexSetupStatus: vi.fn().mockResolvedValue(missingRuntime),
      installCli: vi.fn(),
      installCodexDesktop: vi.fn(),
    }
    const listener = callbacks()

    await expect(prepareCodexEnvironment(api, listener.value)).resolves.toMatchObject({
      outcome: 'runtime-required',
      status: missingRuntime,
    })
    expect(api.installCli).not.toHaveBeenCalled()
    expect(listener.value.onAction).toHaveBeenLastCalledWith('idle')
  })

  it('installs a missing CLI, rechecks it and reaches the ready state', async () => {
    const before = setupStatus({ cli: false })
    const ready = setupStatus()
    const api: CodexSetupApi = {
      getCodexSetupStatus: vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(ready),
      installCli: vi.fn().mockResolvedValue(undefined),
      installCodexDesktop: vi.fn(),
    }
    const listener = callbacks()

    await expect(prepareCodexEnvironment(api, listener.value)).resolves.toEqual({ outcome: 'ready', status: ready })
    expect(api.installCli).toHaveBeenCalledWith('codex')
    expect(listener.value.onLog).toHaveBeenCalledWith('正在安装 @openai/codex@latest', 'replace')
    expect(listener.value.onAction).toHaveBeenLastCalledWith('idle')
  })

  it('returns a retryable failure when CLI installation finishes without a detectable command', async () => {
    const missingCli = setupStatus({ cli: false })
    const api: CodexSetupApi = {
      getCodexSetupStatus: vi.fn().mockResolvedValue(missingCli),
      installCli: vi.fn().mockResolvedValue(undefined),
      installCodexDesktop: vi.fn(),
    }
    const listener = callbacks()

    const result = await prepareCodexEnvironment(api, listener.value)
    expect(result).toMatchObject({ outcome: 'failed', phase: 'cli', status: missingCli })
    expect((result as { error: Error }).error.message).toContain('仍未检测到命令')
    expect(listener.value.onAction).toHaveBeenLastCalledWith('idle')
  })

  it('keeps a completed CLI usable when optional desktop installation fails', async () => {
    const cliReady = setupStatus({ desktop: false })
    const desktopError = new Error('微软商店连接失败')
    const api: CodexSetupApi = {
      getCodexSetupStatus: vi.fn().mockResolvedValue(cliReady),
      installCli: vi.fn(),
      installCodexDesktop: vi.fn().mockRejectedValue(desktopError),
    }
    const listener = callbacks()

    await expect(prepareCodexEnvironment(api, listener.value)).resolves.toEqual({
      outcome: 'desktop-recovery',
      status: cliReady,
      error: desktopError,
    })
    expect(listener.value.onAction).toHaveBeenLastCalledWith('idle')
  })

  it('does not call the managed desktop installer when macOS owns installation', async () => {
    const cliReady = setupStatus({ desktop: false })
    const api: CodexSetupApi = {
      getCodexSetupStatus: vi.fn().mockResolvedValue(cliReady),
      installCli: vi.fn(),
      installCodexDesktop: vi.fn(),
    }
    const listener = callbacks()

    await expect(prepareCodexEnvironment(
      api,
      listener.value,
      platformCapabilitiesFor('darwin', 'arm64'),
    )).resolves.toEqual({ outcome: 'ready', status: cliReady })
    expect(api.installCodexDesktop).not.toHaveBeenCalled()
  })

  it('shows desktop recovery when installation returns without a detectable AppX package', async () => {
    const desktopMissing = setupStatus({ desktop: false })
    const api: CodexSetupApi = {
      getCodexSetupStatus: vi.fn().mockResolvedValue(desktopMissing),
      installCli: vi.fn(),
      installCodexDesktop: vi.fn().mockResolvedValue(undefined),
    }
    const listener = callbacks()

    const result = await prepareCodexEnvironment(api, listener.value)
    expect(result).toMatchObject({ outcome: 'desktop-recovery', status: desktopMissing })
    expect((result as { error: Error }).error.message).toContain('仍未检测到应用')
    expect(api.getCodexSetupStatus).toHaveBeenCalledTimes(2)
  })
})

describe('installNodeAndPrepareCodexEnvironment', () => {
  it('returns to an idle retry state when automatic Node.js installation fails', async () => {
    const installError = new Error('MSI 安装失败')
    const api = {
      getCodexSetupStatus: vi.fn(),
      installNodeRuntime: vi.fn().mockRejectedValue(installError),
      installCli: vi.fn(),
      installCodexDesktop: vi.fn(),
    }
    const listener = callbacks()

    await expect(installNodeAndPrepareCodexEnvironment(api, listener.value)).resolves.toEqual({
      outcome: 'node-failed',
      status: null,
      error: installError,
    })
    expect(listener.value.onAction).toHaveBeenLastCalledWith('idle')
  })

  it('rechecks PATH-visible runtimes before continuing the rest of setup', async () => {
    const ready = setupStatus()
    const api = {
      getCodexSetupStatus: vi.fn().mockResolvedValue(ready),
      installNodeRuntime: vi.fn().mockResolvedValue({
        installed: true,
        method: 'winget' as const,
        source: 'winget',
        version: null,
        architecture: 'x64' as const,
        pathRefreshRequired: true,
        systemRestartRequired: false,
      }),
      installCli: vi.fn(),
      installCodexDesktop: vi.fn(),
    }
    const listener = callbacks()

    await expect(installNodeAndPrepareCodexEnvironment(api, listener.value)).resolves.toEqual({
      outcome: 'setup',
      setup: { outcome: 'ready', status: ready },
    })
    expect(api.getCodexSetupStatus).toHaveBeenCalledTimes(2)
  })
})
