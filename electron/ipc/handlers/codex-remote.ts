// 主窗口业务通道的处理器：手机遥控 Codex 的开关、工作文件夹、配对、解绑和飞书凭据。
// 微信那几条（扫码登录）在 codex-remote-weixin.ts，同用 ctx.codexRemote()。
import { BrowserWindow, dialog, type OpenDialogOptions } from 'electron'
import {
  requestFeishuTenantToken,
  serializeFeishuCredential,
  validateFeishuCredentialInput,
} from '../../codex-remote-feishu'
import { parseFeishuCredentialRequest, parseRemoteChannel, parseRemoteEnabled } from '../parsers/codex-remote'
import type { IpcHandlerContext } from './context'

export function registerCodexRemoteHandlers(ctx: IpcHandlerContext): void {
  const { registerTrustedHandler, codexRemote } = ctx
  registerTrustedHandler('codex-remote:get-state', () => codexRemote().snapshot())
  registerTrustedHandler('codex-remote:set-channel-enabled', (_event, channel: unknown, enabled: unknown) => (
    codexRemote().setChannelEnabled(parseRemoteChannel(channel), parseRemoteEnabled(enabled))
  ))
  registerTrustedHandler('codex-remote:choose-workspace', async (event) => {
    const service = codexRemote()
    const parentWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const dialogOptions: OpenDialogOptions = {
      title: '选择手机遥控时 Codex 干活的文件夹',
      properties: ['openDirectory', 'createDirectory'],
    }
    const result = parentWindow ? await dialog.showOpenDialog(parentWindow, dialogOptions) : await dialog.showOpenDialog(dialogOptions)
    if (result.canceled || !result.filePaths[0]) return service.snapshot()
    // 路径来自系统对话框，不来自渲染层（I5）；能不能用由 validateRemoteWorkspace 判断。
    return service.setWorkspace(result.filePaths[0])
  })
  registerTrustedHandler('codex-remote:start-pairing', (_event, channel: unknown) => codexRemote().startPairing(parseRemoteChannel(channel)))
  registerTrustedHandler('codex-remote:cancel-pairing', (_event, channel: unknown) => codexRemote().cancelPairing(parseRemoteChannel(channel)))
  registerTrustedHandler('codex-remote:unbind', (_event, channel: unknown) => codexRemote().unbind(parseRemoteChannel(channel)))
  registerTrustedHandler('codex-remote:clear-credentials', (_event, channel: unknown) => (
    codexRemote().saveChannelCredential(parseRemoteChannel(channel), null, null)
  ))
  registerTrustedHandler('codex-remote:save-feishu-credentials', async (_event, rawRequest: unknown) => {
    const service = codexRemote()
    const request = parseFeishuCredentialRequest(rawRequest)
    const credential = validateFeishuCredentialInput(request.appId, request.appSecret)
    // 先拿去飞书换一次访问凭证：填错了当场说，不等打开遥控才发现连不上。
    const deps = service.channelDependencies('feishu')
    await requestFeishuTenantToken(deps.fetch, credential, deps.now())
    return service.saveChannelCredential('feishu', serializeFeishuCredential(credential), credential.appId)
  })
}
