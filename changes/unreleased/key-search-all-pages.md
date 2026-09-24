## 用户

- 密钥页的搜索会在全部密钥里找，不再只找当前这一页；要找的密钥在第二页以后也能直接搜到。

## 开发

- #495（审计 D21）：`account:list-keys` 的查询多一个可选 `keyword`（`NewApiAccountKeysQuery`，`ipc.ts` 限 64 字），带上时主进程用新的 `searchAccountKeys`（`account-key-quota.ts`，与 `findAccountKeyById` 同一个翻页安全阀）翻完整张列表按名称、分组筛完再分页，搜索词不发给后端；翻不完就报错，不拿半截结果说「没有」。渲染层 `pages-account.tsx` 停手 300 毫秒后带搜索词重查、回到第一页，去掉原先只筛本页的本地过滤。通道不变，三处通道表无需改动。
