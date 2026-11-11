## 开发

- 手机遥控微信扫码认得腾讯新加的扫码状态 `confirmed_but_need_verifycode`（手机上点了确认、还要输手机微信显示的数字）：
  `electron/codex-remote-weixin-api.ts` 新增 `weixinStatusNeedsVerifyCode`，照腾讯 openclaw-weixin 3.0.0-beta-0 的
  `statusNeedsVerifyCode`，状态名含 `need_verifycode` 的一律走现成的输数字界面。以前这个状态落进 `default`，客户只看到
  「微信扫码登录失败，请重试」。带 `confirmed_but_…` 的回应即使已经附了令牌也不收，只在随后那次普通的 `confirmed` 里存，
  手机数字这道校验跳不过去。配对码逻辑没动。
