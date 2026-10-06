## 用户

- Mac 上自己装过的 Node.js 太旧（低于 20）时，星芒改用自己准备的那份 Node.js 来检测、装工具和打开工具：首页不再一直提示
  Node.js 版本过低，装工具时也不会每次都重新下载一遍 Node.js。还没准备过的先下载一次，下好马上就用上。
  你自己在终端里、项目里用的 node 不变。

## 开发

- 第三十四批 A（只 Mac）：代下的 Node.js（`~/Library/Application Support/XingMangAI/Runtime/node`）在 PATH 里排在客户自己那份
  后面（第十六批 2）。客户那份低于 20 或读不出版本时，代下的那份永远轮不到：检测一直报版本过低，`planCliInstall` 每次装工具都把
  Node.js 排进准备步骤重下一遍，装工具用的 npm 也落在旧 node 上。这是对「客户自己的 Node 优先」的一处有意例外。
- `macos-node-runtime.ts` 新加 `resolveDarwinPreferredNodeDirectory`：代下那份不是普通文件就直接回 null，不起进程（绝大多数 Mac
  走这条）；照平常顺序先找到的 node 就是代下那份、或者版本够新，回 null；否则代下那份够新才回它的 bin 目录。
- `system-service.ts` 的 `preferredNodeDirectories` 把这个目录经 `additionalPaths` 排到最前，只用在本软件自己干活的地方：找 node、
  npm、npx 和问版本（`findInstalledExecutable`、`inspectTool`），`npm root --global`（新加的 `resolveServiceNpmGlobalRoot`），装工具
  找 npm 和跑 npm 的环境（`findNpmForCliInstall`、`resolveNpmBaseEnvironment`），打开工具时 `resolveCliCommand` 新加的
  `nodeDirectories`（JS 写的工具先在这里找 node）。判断结果 15 秒内共用（`scanReuseMs`），强制重新检测、装完 Node.js 后重新判断，
  缺代下那份的下好当场就用上。交给终端的环境、`~/.zprofile`、客户 node 够新的 Mac、Windows 和 Linux 都不动。
- `diagnostics.ts` 检查页的 Node.js、npm 两项同样先看代下那份，和首页一致。
- 不在这次范围：卸载工具用的 npm、画图 MCP 写进配置的 node（`main.ts`）、Codex 扩展管理（`codex-extensions.ts`）仍按原来的顺序找 node。
- 测试：`macos-node-runtime.test.ts` 钉判断规则；`tool-installation.test.ts` 钉 `nodeDirectories` 与 `npm root --global` 的 PATH；
  `system-service.test.ts` 按 darwin 跑检测、装 Node.js（已有不重下、缺的下好当场切换）、装工具的 npm 与 PATH、打开工具的
  `nodeDirectories` 与终端 PATH（Windows 主机上不跑）。
