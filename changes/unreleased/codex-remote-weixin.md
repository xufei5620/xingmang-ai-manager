## 用户

- 手机遥控 Codex 加了微信（实验功能）：用手机微信扫码登录、配对以后，在微信的 ClawBot 对话里就能让这台电脑上的
  Codex 干活，跟飞书一样只认配对过的那一个人、跑命令先问你。这条通道是腾讯给 OpenClaw 开的，随时可能断，
  长期用建议选飞书。

## 开发

- 微信渠道走腾讯 iLink（ilinkai.weixin.qq.com）长轮询，收发和扫码的写法照 @tencent-weixin/openclaw-weixin
  2.4.10（MIT）核对，代码自己写：`electron/codex-remote-weixin-api.ts`（请求，只认 https 的 *.weixin.qq.com，
  redirect_host 和 baseurl 都过这道；64 位消息编号保精度解析）、`codex-remote-weixin.ts`（渠道，只交回扫码人的
  消息、也只往他那里发；-14 和 401/403 报 needs-login 不再重试；context_token 过期去掉重发一次）、
  `codex-remote-weixin-login.ts`（扫码登录，二维码在主进程画成图，令牌直接进底座的加密凭据存储，不过 IPC）。
- 设置页微信那一块 `WeixinRemoteSection.tsx` 登记在 `channel-sections.tsx`：拿二维码走卡片的 `run`，扫码弹窗里的轮询和输数字
  自己管，登录好了靠主进程推的快照变成「已登录」；退出登录用卡片共用的那颗。
- 新增三条 IPC：`codex-remote:weixin-login-start` / `-poll` / `-cancel`，成功不记日志（结果是登录二维码）。
