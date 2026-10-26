// 主窗口业务通道的处理器：「设置 › 手机遥控 Codex」里微信那一块的扫码登录。开关、配对、凭据清除
// 这些两个渠道共用的在 codex-remote.ts，同用 ctx.codexRemote()。
import QRCode from 'qrcode'
import type { RemoteChannelDependencies } from '../../codex-remote-channel'
import { buildWeixinBotAgent } from '../../codex-remote-weixin-api'
import { createWeixinLoginController, type WeixinLoginController } from '../../codex-remote-weixin-login'
import { parseWeixinLoginId, parseWeixinLoginPollInput } from '../parsers/codex-remote-weixin'
import type { IpcHandlerContext } from './context'

/** 扫码登录要用的那两样：跟渠道同一份的依赖，和带界面字样一起存凭据的入口。 */
export interface WeixinLoginHost {
  channelDependencies(channel: 'weixin'): RemoteChannelDependencies
  saveChannelCredential(channel: 'weixin', value: string | null, accountLabel: string | null): Promise<unknown>
}

export function createWeixinLoginForHost(host: WeixinLoginHost): WeixinLoginController {
  const dependencies = host.channelDependencies('weixin')
  return createWeixinLoginController({
    fetch: dependencies.fetch,
    botAgent: buildWeixinBotAgent(dependencies.appVersion),
    now: () => dependencies.now(),
    readCredential: () => dependencies.readCredential(),
    saveCredential: async (value, accountLabel) => {
      await host.saveChannelCredential('weixin', value, accountLabel)
    },
    renderQrCode: (content) => QRCode.toDataURL(content, { errorCorrectionLevel: 'M', margin: 2, width: 280 }),
    log: (level, event, detail) => dependencies.log(level, event, detail),
  })
}

export function registerCodexRemoteWeixinHandlers(ctx: IpcHandlerContext): void {
  const { registerTrustedHandler, codexRemote } = ctx
  // 遥控服务在主窗口之后才建好，登录控制器等第一次扫码时再建；没建好时 codexRemote() 抛的那句照样上屏。
  let login: WeixinLoginController | null = null
  function controller(): WeixinLoginController {
    login ??= createWeixinLoginForHost(codexRemote())
    return login
  }
  registerTrustedHandler('codex-remote:weixin-login-start', () => controller().start())
  registerTrustedHandler('codex-remote:weixin-login-poll', (_event, input: unknown) => {
    const parsed = parseWeixinLoginPollInput(input)
    return controller().poll(parsed.loginId, parsed.verifyCode)
  })
  registerTrustedHandler('codex-remote:weixin-login-cancel', (_event, loginId: unknown) => {
    const id = parseWeixinLoginId(loginId)
    login?.cancel(id)
  })
}
