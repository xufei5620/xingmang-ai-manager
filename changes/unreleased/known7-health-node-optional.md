## 用户

- 一个命令行工具都没装时（比如只用 Codex 桌面端），检查页 Node.js、npm 没装从红色「待处理」改成黄色「需留意」，
  窗口底部「环境有 N 项需要处理」和开机提示也不再把这两项算进去，和首页「运行环境」写的「可选 · 未装」一致。
  装着任一命令行工具的照旧是「待处理」。

## 开发

- 已知7（第二十九批「看过但不列」那条，当时等的首页运行环境卡已随 #797 合入）：`diagnostics.ts` 加
  `reconcileNodeRuntimeWithClis`，跑完所有检查后，四个 `CLI_*` 都确认没装（`details.installed === false`）时，把没装的
  `RUNTIME_NODE` / `RUNTIME_NPM` 从 `fail` 降成 `warn`；结论照旧「未安装」，「去处理」照旧去「安装卸载」。有一家装着、或者
  那一项没查出来（超时、出错）的照旧 `fail`，同首页的 `nodeOptional`。降黄不是不出：Codex 桌面端的「星芒画图」要 Node.js。
  用跑完的结果判断，不为这个再探一遍四家工具。不加字。
- 测试：`diagnostics.test.ts` 四条（都没装时两行是 `warn`、计数跟着变；装着 Codex 照旧 `fail`；有一家没查出来照旧 `fail`；
  Node.js 那一项超时、Python 和 Git 不动）。
