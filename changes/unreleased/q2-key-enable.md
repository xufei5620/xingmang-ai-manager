## 用户

- 密钥管理里停用的密钥可以直接点「启用」

## 开发

- 个人中心 › 密钥管理：停用（2）、已过期（3）、额度用完（4）的那一行，在「配置到工具」前面多一颗「启用」（0.2.25 总单 Q2）。
  只有星芒账号有；历史账号的后台在 `sub2api-relay-backend.ts`，这次不动，那边不摆这颗按钮（`keyCanEnable`）。
- 新增主窗口通道 `account:enable-key`（`[id: number] → void`，契约、preload、注册、`ipc-channel-policy.ts` 四处齐），
  `RelayBackendClient` 多一个可选的 `enableKey`，只有 new-api 实现：照网页「令牌管理」的「启用」发
  `PUT /api/token/?status_only=true`、body 只有 `{id, status: 1}`（rc.44 / rc.51 `controller/token.go` 的 `UpdateToken`，
  `status_only` 时只改状态，别的字段不用读回再写）。
- 发之前先 `GET /api/token/:id`：服务端只在还标着已过期 / 额度用完、并且确实还过期 / 还没额度时拒绝，网页上停用过、
  到期时间或额度其实也没了的它照样打开，一用又被标回去（`model/token.go` 的 `ValidateUserToken`）。所以过了到期时间、
  限额又用完的两种在客户端先停下，说先去「编辑」改什么；已经启用的不发。启用不动明文、名字和分组，不清本机工具密钥缓存。
- D3（#1660 / #1723）那句「工具的密钥已经停用或到期」不再指到网页「令牌管理」，改指「个人中心 › 密钥管理」点「启用」。
