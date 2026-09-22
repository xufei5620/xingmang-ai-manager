## 用户

- 保存 WorkBuddy、Claude Desktop、OpenCode 的配置之后会立刻测一次，结果就写在保存成功的提示里：
  密钥和模型在当前账号下能不能用；不通时直接说卡在密钥、额度、分组还是模型哪一层。
- 检查页的「连接自检」现在也会测已经装好的这三个客户端，和四个命令行工具排在一起。
- 反馈报告的「工具与配置」段补上这三个客户端各一行：装没装、什么版本、配置有没有指向当前账号。
- 这次自检核对的是当前账号的密钥与模型；客户端自己发出的那次对话由客户端进程完成，
  本机测不到，结论里会写明，不会因为测过就说成全都正常。

## 开发

- 新增 `electron/external-client-connection.ts`：外部客户端的连接自检。探测计划与收发、归因表
  和四个 CLI 共用一份 —— `connection-check.ts` 把结论拆成 `ConnectionProbeReport`（不含身份），
  `runConnectionProbe` 只管收发，`ConnectionProbePlan` 的 `provider`/`siteId` 换成 `name`，
  身份由 `runConnectionCheck` / `runExternalClientCheck` 各自贴上。
- 三个客户端都走只读模型清单探测：Claude Desktop 的网关地址是裸域拼 `v1/models`，
  WorkBuddy 与 OpenCode 写的是自带 `/v1` 的地址拼 `models`，落到同一个已实测端点，不花额度。
  无 `default` 分支的 switch 保证加第四个客户端时漏在这里是编译错。
- 密钥从客户端自己的配置文件读回来：`external-tool-config.ts` 拆出内部的 `inspectExternalTool`
  与 `resolveExternalToolProbeCredential`，`claude-desktop-config.ts` 拆出 `inspectGateway`
  与 `inspectGatewayCredential`；对外的 `inspectExternalToolConnection` / `inspectConnection`
  解构剥掉明文 Key 再返回（I3，同 `toNativeConfigSummary`）。只有确认归属当前账号的那一条才给密钥。
- `system-service.ts`：新增 `checkExternalClientConnection(tool, knownStatus?)` 与
  `getLastExternalClients()`；`configureExternalTool` 写完后复用同一条路自检，
  `ExternalClientConfigResult.connectionVerified` 由恒为 `false` 改成真实结果，新增 `connection`
  字段，两条成功文案去掉「未验证实际模型调用」。`knownStatus` 让保存后的复测不再多跑一轮
  Windows 上的 PowerShell 盘点。
- 新通道 `diagnostics:check-external-connection`（`ipc-contract.ts` / `preload.ts` / `ipc.ts` 三处
  同序，T1）；IPC 日志留 `tool` / `layer` / `ok` / `installed` / `siteId` / `status`，不留地址与密钥。
- `feedback-environment.ts` 的「工具与配置」段接上 `externalToolIds`，客户端三行只读上一次检测
  的快照，不为了生成报告再探测一轮。
- 渲染层：`connectionCheckView` 收 `ConnectionProbeReport`，CLI 与客户端共用同一种结果条；
  检查页只列已安装的客户端（`installed`），不给它们「重新写入 Key」；
  `ExternalClientDialog` 在保存成功的 Notice 里多一行自检结论。
