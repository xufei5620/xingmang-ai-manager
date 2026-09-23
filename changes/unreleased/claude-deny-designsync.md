## 用户

- 用当前账号跑 Claude Code 时，它不会再去调一个只有官方账号才能用的设计同步功能。

## 开发

- `electron/config-files.ts`：Claude 星芒来源的 `permissions.deny` 在 `Artifact` 之外再加 `DesignSync`，切回官方账号时两项一起撤掉。2.1.277 在第三方 base URL 上每次请求都把 DesignSync 发给模型，而它要 claude.ai 登录才能用；沙箱实测 deny 后工具从 21 个变 20 个。对应「接中转后的官方体验差距」C7。
