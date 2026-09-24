## 用户

- 撤销工具正在用的密钥时，如果这个工具的配置是你自己填的、软件没有替它换新密钥，页面会照实说它还在用刚撤销的密钥，并给一颗「去设置」直接改用当前账号，不再误报「已自动换上新密钥」。

## 开发

- #478（审计 D04）：`App.tsx` 的 `rewriteAccountKeys` 点名重写时，被规划器跳过（手填、来源没确认、官方等）的工具不再算成功，抛 `KeyRewriteSkippedError`（`features/tools/account-bootstrap.ts`，另有纯函数 `skippedNamedProviders`）。`pages-account.tsx` 的 Key 页据此区分「没换成、再换一次」与「跳过了、去设置」两种提示；「去设置」经新的 `onConfigureTool` 打开该工具的设置（`pages-business.tsx` 接 `openConfig`）。`e2e/v2-business.test.mjs` 加手填工具的撤销用例。
