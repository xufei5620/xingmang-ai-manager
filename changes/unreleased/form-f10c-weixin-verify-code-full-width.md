## 开发

- 微信扫码登录时手机上那串数字认全角数字了（表单 F10-c）：`electron/codex-remote-weixin-login.ts` 的
  `normalizeWeixinVerifyCode` 先把全角数字换成半角再认，跟两步验证码 `parseTwoFactorCode` 一样；字母、横杠、
  别的文字的数字照旧不收，界面文字不变。以前中文输入法全角状态下打的数字会报「请输入手机微信上显示的数字」。
