## 用户

- 充值可以直接在星芒里开发票了：在「我的订单」里点订单右边的「开发票」。

## 开发

- 「我的订单」里直接开发票，替掉 0.2.24 的开票窗口（删掉 `invoice-portal-window.ts` 和 `account:open-invoice-portal`）。主进程 `invoice-center-client.ts` 按 xingmang-console 的契约 `platform/contracts/auth/invoice-desktop-session.v1.md`，借当前账号的 access token（星芒账号另带用户编号）向本站点开票系统换一张桌面令牌，再用它读订单、抬头、开票记录，提交、撤回申请，取发票文件；令牌只在内存里，401 时重换一次，换人或退出就撤销。这是账号凭据唯一一处发往账号站以外的主机，AGENTS.md I3 已登记。
- 新增 7 条主窗口通道 `account:list-invoice-orders` / `list-invoice-profiles` / `list-invoice-requests` / `save-invoice-profile` / `submit-invoice-request` / `withdraw-invoice-request` / `save-invoice-document`，入参在 `ipc/parsers/account-invoice.ts` 逐项核对，客户是谁、哪个站、币种一律不收；发票文件由主进程按开头字节认类型、客户在保存框里选位置、原子写（`invoice-document-save.ts`）。
- 账号侧：`RelayBackendClient` 多一个可选的 `lendInvoiceCredential`，new-api 在 `new-api-client.ts` 里实现，历史账号在 `bootstrap/accounts.ts` 包一层（不动 `sub2api-relay-backend.ts`）；开票系统拒了只续一次登录，不会因此把客户登出。
- 界面在 `features/account/AccountInvoice.tsx` / `invoice.ts`；顶部搜「发票」「开票」「报销」落到「我的订单」，使用教程「账号、充值与额度」多一问「要开发票？」。
- 旧版开票窗口留下的 `persist:xingmang-invoice-*` 会话分区没有清理，只占一点磁盘。
