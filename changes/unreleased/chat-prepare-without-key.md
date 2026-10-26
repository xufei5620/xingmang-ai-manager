## 开发

- 聊天、视频剪辑、画布准备分组（列模型）时不再给每个分组签对话密钥（0.2.22 发版前回归检查第 1 条，#1399 带进来的，没发出去过）：
  `chat-credential-coordinator.ts` 的 `prepareGroup` 在星芒账号上改用登录态读 `GET /api/user/models?group=`
  （`new-api-client.ts` 新增 `listGroupModels`），不读本机密钥、不签、不取明文；对话密钥等客户在这个分组发第一句话、
  出第一张图时由 `resolveCredential` 签，签好照旧复用（名字仍是「用户名-分组-对话」）。原因：new-api 签一把要
  `POST /api/token/:id/key` 取一次明文，它挂在 `CriticalRateLimit` 上，按出口 IP 20 分钟 20 次，和登录、续登录、
  退出、充值下单共用；十来个分组一起签会把它用光，续登录跟着被拒，余额、密钥、充值一起报连不上。
  历史账号（Sub2API）没有这个接口，照旧靠分组的密钥列模型。`chat-models-by-vendor.md` 里「打开聊天时没对话密钥的分组
  这时签一把」以这一条为准。
