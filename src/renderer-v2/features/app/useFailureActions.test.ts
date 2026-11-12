import { describe, expect, it, vi } from 'vitest'
import { codexDesktopStoreUrl } from '../../../../electron/codex-desktop-install-failure'
import { ExternalUrlBlockedError } from '../../../../electron/external-url-blocked'
import { errorMessage } from '../../business-common'
import { codexDesktopStoreUnavailableMessage, openCodexDesktopStoreOrExplain } from './useFailureActions'

describe('openCodexDesktopStoreOrExplain', () => {
  it('opens the allowlisted Store link and resolves when the system takes it', async () => {
    const openExternal = vi.fn(async () => true)
    await expect(openCodexDesktopStoreOrExplain(openExternal)).resolves.toBeUndefined()
    expect(openExternal).toHaveBeenCalledWith(codexDesktopStoreUrl)
  })

  it('explains the missing Store when the main process rejects the open (L6)', async () => {
    // external:open never resolves false: when shell.openExternal cannot open the
    // ms-windows-store: link (LTSC or stripped-down Windows), Electron rejects and
    // the bridge hands the renderer this wrapped English error.
    const bridged = new Error("Error invoking remote method 'external:open': Error: Failed to open: 系统找不到指定的文件。")
    const failure = await openCodexDesktopStoreOrExplain(async () => { throw bridged }).catch((cause: unknown) => cause)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe(codexDesktopStoreUnavailableMessage)
    // The error dialog shows the guidance as it is, not the generic fallback.
    expect(errorMessage(failure, '打开微软商店没有完成')).toBe(codexDesktopStoreUnavailableMessage)
  })

  it('still explains the missing Store when the open resolves false', async () => {
    await expect(openCodexDesktopStoreOrExplain(async () => false)).rejects.toThrow(codexDesktopStoreUnavailableMessage)
  })

  it('reports an allowlist rejection as it is instead of blaming the Store', async () => {
    const blocked = new ExternalUrlBlockedError()
    await expect(openCodexDesktopStoreOrExplain(async () => { throw blocked })).rejects.toBe(blocked)
    const bridged = new Error("Error invoking remote method 'external:open': ExternalUrlBlockedError: 不允许打开该链接")
    await expect(openCodexDesktopStoreOrExplain(async () => { throw bridged })).rejects.toBe(bridged)
  })
})
