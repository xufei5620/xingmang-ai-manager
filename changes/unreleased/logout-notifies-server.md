## 用户

- 点「退出登录」时会顺带告诉服务器这台电脑不再使用，个人中心的「登录设备」不会再越积越多。网络不好时也不耽误退出。
- 同一个账号登录的设备太多时，登录框会说清楚原因和怎么处理，不再只说「请稍后重试」；登录太频繁时也会提示过一会儿再试。

## 开发

- 全面检测 Q11：`electron/new-api-client.ts` 新增 `endServerSession()`，只在显式退出时尽力发一次
  `POST /api/user/auth/logout`（Bearer + New-Api-User + refresh cookie，3 秒超时、16 KB 应答上限，走
  `performRequest` 的重定向拒绝与来源校验），永不抛错、不改本地会话。端点与语义已按上游 new-api
  v1.0.0-rc.24 `router/api-router.go`、`controller/auth_session.go` 逐行核对。
- `electron/realm-account-service.ts` 的 `logout()` 在本机账号库删掉凭据之后、清内存之前发起它（不等待）；
  切换已保存账号、重新登录、移除账号和丢弃候选句柄仍只走本地 `logout()`，不会把保存的账号在服务端登出。
  业务代理不暴露 `endServerSession`。历史账号（Sub2API）仓内没有登出端点的侦察记录，不接。
- 登录遇到 409 `AUTH_SESSION_LIMIT`（50 个在用会话）、429 `AUTH_SESSION_ISSUANCE_LIMIT`（24 小时 100 次）
  和限流空 429 时，主进程给出专门的中文文案，renderer-v2 `account-errors.ts` 同步认这几句；
  新增测试钉住两边一致。只给文字不给按钮：官网登录会撞上同一个设备数上限，按钮帮不上忙。
