## 开发

- Fable 手机遥控 YF-5（yoyo 2026-11-11 亲手打字「微信免配对码，加条件做」）：`fetchWeixinLoginQrCode` 请求体多带
  `bot_spam_business_data`（`weixinVerifyPinBusinessData`，照腾讯 openclaw-weixin 3.0.0-beta-0 的 `encodeBotSpamBusinessData`，
  base64 的 `{"verify_pin":1}`），请微信每次都要扫码人输手机上那串数字。`codex-remote-weixin-login.ts` 按一张二维码记
  `pinAsked` / `pinAccepted`：微信回过要数字、之后带着数字问回来拿到已扫码或确认才算过；换二维码清零。过了且确认里有
  `ilink_user_id` 时 `saveCredential` 多传扫码人编号，`saveChannelCredential` 的新可选参数 `verifiedPeerUserId` 直接把他记成
  绑定的人（原来绑着别人时照换人那样先说一声、挂着的配对码作废，日志 `remote.paired-by-scan`），快照 `boundByScan` 让弹窗说
  「已经绑定你这个微信」。#1772 起名字里带 need_verifycode 的（含 `confirmed_but_need_verifycode`）都算微信要过数字。
  没过数字的登录行为不变。用户行并在 `codex-remote-fixes-0224.md`。
