import { describe, expect, it, vi } from 'vitest'
import { platformCapabilitiesFor } from '../electron/platform-capabilities'
import type { AppConfigSummary, CodexSetupStatus, ToolStatus } from './types'
import {
  CODEX_SETUP_STATUS_TIMEOUT_MS,
  authorizeCodex,
  authorizeManagedCodex,
  buildCodexDetectionFailureMessage,
  DEFAULT_CODEX_MODEL,
  prepareCodexEnvironment,
  prepareCodexEnvironmentAutomatically,
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

describe('authorizeManagedCodex', () => {
  const config = { workspace: 'C:\\work', providers: {} } as AppConfigSummary

  it('configures Codex through the main-process managed-key path without requesting key plaintext', async () => {
    const api = {
      configureManagedCliKeys: vi.fn().mockResolvedValue({ configured: ['codex'], failed: [] }),
      getConfig: vi.fn().mockResolvedValue(config),
    }

    await expect(authorizeManagedCodex(api)).resolves.toBe(config)
    expect(api.configureManagedCliKeys).toHaveBeenCalledWith({
      providers: ['codex'],
      preferredModels: { codex: DEFAULT_CODEX_MODEL },
    })
    expect(api.getConfig).toHaveBeenCalledTimes(1)
  })

  it('surfaces the provider failure and leaves config unread when automatic authorization fails', async () => {
    const api = {
      configureManagedCliKeys: vi.fn().mockResolvedValue({
        configured: [],
        failed: [{ provider: 'codex', message: '本地托管 API Key 配置已损坏或无法解密' }],
      }),
      getConfig: vi.fn(),
    }

    await expect(authorizeManagedCodex(api)).rejects.toThrow('本地托管 API Key 配置已损坏或无法解密')
    expect(api.getConfig).not.toHaveBeenCalled()
  })

  it('uses a clear fallback when the main process returns no Codex result', async () => {
    const api = {
      configureManagedCliKeys: vi.fn().mockResolvedValue({ configured: [], failed: [] }),
      getConfig: vi.fn(),
    }

    await expect(authorizeManagedCodex(api)).rejects.toThrow('Codex 专属 Key 尚未就绪')
  })
})

describe('buildCodexDetectionFailureMessage', () => {
  it('returns null when the desktop probe concluded normally, even if optional tools are missing', () => {
    expect(buildCodexDetectionFailureMessage(setupStatus())).toBeNull()
    expect(buildCodexDetectionFailureMessage(setupStatus({ node: false, npm: false, cli: false }))).toBeNull()
  })

  it('only reports a failed desktop probe', () => {
    const base = setupStatus()
    const status: CodexSetupStatus = {
      ...base,
      desktop: { ...base.desktop, installed: false, detectionFailed: true, detectionError: '桌面端探测超时' },
    }
    expect(buildCodexDetectionFailureMessage(status)).toBe('Codex 桌面端暂时无法确认状态，请重试检测')
  })

  it('ignores optional runtime and CLI probe failures', () => {
    const base = setupStatus()
    const status: CodexSetupStatus = {
      ...base,
      runtime: { ...base.runtime, node: failedTool() },
      cli: failedTool(),
    }
    expect(buildCodexDetectionFailureMessage(status)).toBeNull()
  })
})

describe('prepareCodexEnvironment', () => {
  it('returns a detection-failed outcome and never triggers an automatic install when a probe could not confirm status', async () => {
    const base = setupStatus()
    const status: CodexSetupStatus = {
      ...base,
      desktop: { ...base.desktop, installed: false, detectionFailed: true, detectionError: '桌面端探测超时' },
    }
    const api: CodexSetupApi = {
      getCodexSetupStatus: vi.fn().mockResolvedValue(status),
      installCodexDesktop: vi.fn(),
    }
    const listener = callbacks()

    const result = await prepareCodexEnvironment(api, listener.value)

    expect(result).toEqual({
      outcome: 'detection-failed',
      status,
      message: 'Codex 桌面端暂时无法确认状态，请重试检测',
    })
    expect(api.installCodexDesktop).not.toHaveBeenCalled()
    expect(listener.value.onAction).toHaveBeenLastCalledWith('idle')
  })

  it('continues when Node.js, npm and Codex CLI are missing because they are optional', async () => {
    const status = setupStatus({ node: false, npm: false, cli: false })
    const api: CodexSetupApi = {
      getCodexSetupStatus: vi.fn().mockResolvedValue(status),
      installCodexDesktop: vi.fn(),
    }
    const listener = callbacks()

    await expect(prepareCodexEnvironment(api, listener.value)).resolves.toEqual({ outcome: 'ready', status })
    expect(api.installCodexDesktop).not.toHaveBeenCalled()
  })

  it('applies the bundled Chinese locale after Codex Desktop is ready', async () => {
    const status = setupStatus({ node: false, npm: false, cli: false })
    const api: CodexSetupApi = {
      getCodexSetupStatus: vi.fn().mockResolvedValue(status),
      installCodexDesktop: vi.fn(),
      setCodexDesktopLocale: vi.fn().mockResolvedValue({ effectiveLocale: 'zh-CN' }),
    }
    const listener = callbacks()

    await expect(prepareCodexEnvironment(api, listener.value)).resolves.toEqual({ outcome: 'ready', status })
    expect(api.setCodexDesktopLocale).toHaveBeenCalledWith('zh-CN')
    expect(listener.value.onLog).toHaveBeenCalledWith('正在应用 Codex Desktop 简体中文界面', 'append')
    expect(listener.value.onLog).toHaveBeenCalledWith('Codex Desktop 简体中文界面已准备完成', 'append')
  })

  it('keeps onboarding usable when the local Chinese resources cannot be applied', async () => {
    const status = setupStatus({ node: false, npm: false, cli: false })
    const api: CodexSetupApi = {
      getCodexSetupStatus: vi.fn().mockResolvedValue(status),
      installCodexDesktop: vi.fn(),
      setCodexDesktopLocale: vi.fn().mockRejectedValue(new Error('没有本地中文资源')),
    }
    const listener = callbacks()

    await expect(prepareCodexEnvironment(api, listener.value)).resolves.toEqual({ outcome: 'ready', status })
    expect(listener.value.onLog).toHaveBeenCalledWith(
      '简体中文界面暂未应用：没有本地中文资源；不影响继续使用',
      'append',
    )
  })

  it('installs a missing desktop app and rechecks it without installing optional tools', async () => {
    const before = setupStatus({ node: false, npm: false, cli: false, desktop: false })
    const ready = setupStatus({ node: false, npm: false, cli: false })
    const api: CodexSetupApi = {
      getCodexSetupStatus: vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(ready),
      installCodexDesktop: vi.fn().mockResolvedValue(undefined),
    }
    const listener = callbacks()

    await expect(prepareCodexEnvironment(api, listener.value)).resolves.toEqual({ outcome: 'ready', status: ready })
    expect(api.installCodexDesktop).toHaveBeenCalledOnce()
    expect(listener.value.onLog).toHaveBeenCalledWith('正在准备 Codex 桌面端最新版', 'append')
    expect(listener.value.onAction).toHaveBeenLastCalledWith('idle')
  })

  it('shows desktop recovery when optional desktop installation fails', async () => {
    const cliReady = setupStatus({ desktop: false })
    const desktopError = new Error('微软商店连接失败')
    const api: CodexSetupApi = {
      getCodexSetupStatus: vi.fn().mockResolvedValue(cliReady),
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
      installCodexDesktop: vi.fn().mockResolvedValue(undefined),
    }
    const listener = callbacks()

    const result = await prepareCodexEnvironment(api, listener.value)
    expect(result).toMatchObject({ outcome: 'desktop-recovery', status: desktopMissing })
    expect((result as { error: Error }).error.message).toContain('仍未检测到应用')
    expect(api.getCodexSetupStatus).toHaveBeenCalledTimes(2)
  })
})

describe('prepareCodexEnvironmentAutomatically', () => {
  it('installs only the desktop app and leaves optional runtime and CLI installation to maintenance', async () => {
    const missingDesktop = setupStatus({ node: false, npm: false, cli: false, desktop: false })
    const ready = setupStatus({ node: false, npm: false, cli: false })
    const api = {
      getCodexSetupStatus: vi.fn()
        .mockResolvedValueOnce(missingDesktop)
        .mockResolvedValueOnce(ready),
      installCodexDesktop: vi.fn().mockResolvedValue(undefined),
    }
    const listener = callbacks()

    await expect(prepareCodexEnvironmentAutomatically(
      api,
      listener.value,
      platformCapabilitiesFor('win32', 'x64'),
    )).resolves.toEqual({ outcome: 'ready', status: ready })
    expect(api.installCodexDesktop).toHaveBeenCalledOnce()
  })

  it('never installs over a detection failure', async () => {
    const base = setupStatus({ node: false, npm: false, cli: false })
    const status: CodexSetupStatus = {
      ...base,
      desktop: { ...base.desktop, installed: false, detectionFailed: true, detectionError: '桌面端探测超时' },
    }
    const api = {
      getCodexSetupStatus: vi.fn().mockResolvedValue(status),
      installCodexDesktop: vi.fn(),
    }

    await expect(prepareCodexEnvironmentAutomatically(
      api,
      callbacks().value,
      platformCapabilitiesFor('win32', 'x64'),
      { wait: async () => undefined },
    )).resolves.toMatchObject({ outcome: 'detection-failed' })
    expect(api.installCodexDesktop).not.toHaveBeenCalled()
    expect(api.getCodexSetupStatus).toHaveBeenCalledTimes(3)
  })

  it('recovers automatically when a transient detection failure clears', async () => {
    const base = setupStatus()
    const failed = {
      ...base,
      desktop: { ...base.desktop, installed: false, detectionFailed: true, detectionError: '桌面端探测超时' },
    }
    const ready = setupStatus()
    const wait = vi.fn(async () => undefined)
    const api = {
      getCodexSetupStatus: vi.fn().mockResolvedValueOnce(failed).mockResolvedValueOnce(ready),
      installCodexDesktop: vi.fn(),
    }

    await expect(prepareCodexEnvironmentAutomatically(
      api,
      callbacks().value,
      platformCapabilitiesFor('win32', 'x64'),
      { wait },
    )).resolves.toEqual({ outcome: 'ready', status: ready })
    expect(wait).toHaveBeenCalledWith(750)
  })

  it('does not call the managed desktop installer when macOS owns installation', async () => {
    const missingRuntime = setupStatus({ node: false, npm: false })
    const api = {
      getCodexSetupStatus: vi.fn().mockResolvedValue(missingRuntime),
      installCodexDesktop: vi.fn(),
    }

    await expect(prepareCodexEnvironmentAutomatically(
      api,
      callbacks().value,
      platformCapabilitiesFor('darwin', 'arm64'),
    )).resolves.toEqual({ outcome: 'ready', status: missingRuntime })
    expect(api.installCodexDesktop).not.toHaveBeenCalled()
  })

  it('does not reinstall Codex Desktop after an explicit uninstall preference', async () => {
    const status = setupStatus({ desktop: false })
    const api = {
      getCodexSetupStatus: vi.fn().mockResolvedValue(status),
      installCodexDesktop: vi.fn(),
    }

    await expect(prepareCodexEnvironmentAutomatically(
      api,
      callbacks().value,
      platformCapabilitiesFor('win32', 'x64'),
      { skipDesktopInstall: true },
    )).resolves.toEqual({ outcome: 'ready', status })
    expect(api.installCodexDesktop).not.toHaveBeenCalled()
  })
})

describe('Codex Desktop post-install verification timeout', () => {
  it('returns a retryable recovery result instead of waiting forever after install completes', async () => {
    vi.useFakeTimers()
    try {
      const beforeInstall = setupStatus({ desktop: false })
      const api = {
        getCodexSetupStatus: vi.fn()
          .mockResolvedValueOnce(beforeInstall)
          .mockImplementationOnce(() => new Promise<CodexSetupStatus>(() => undefined)),
        installCodexDesktop: vi.fn().mockResolvedValue(undefined),
      }
      const pending = prepareCodexEnvironment(api, callbacks().value, platformCapabilitiesFor('win32', 'x64'), 1_000)
      await vi.advanceTimersByTimeAsync(1_000)
      await expect(pending).resolves.toMatchObject({
        outcome: 'desktop-recovery',
        error: expect.objectContaining({ message: expect.stringContaining('环境复核超时') }),
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
