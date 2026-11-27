## 用户

- 修复了 Claude Desktop 的 Code 和 Cowork 仍需从国外下载组件、长时间无法启动的问题，现在由星芒预先准备好所需组件。

## 开发

- 替 Claude Desktop 预放 Claude Code（Windows 从 npm 镜像 #1932、Mac 从下载站 #2033）和 Cowork 工作区（#2033）在打包版里一次都没生效：
  主进程的 `node:fs` 被 Electron 的 asar 层改过，路径落在 `*.asar` 上一律当成压缩包的根文件夹，`fs.promises.open(app.asar)` 报
  `EISDIR: illegal operation on a directory`，`stat` 回「文件夹、大小 0、修改时间整个进程不变」。0.2.25 Windows 10 真机测出：
  日志 `claude-desktop.code-seed.skipped` / `claude-desktop.workspace-seed.skipped`，`reason` 是 `asar-unreadable`，`cause` 是 EISDIR；
  单元测试跑在普通 Node 里看不出来。Claude Desktop 的 Code 页因此照旧自己去 downloads.claude.ai 下，停在「Starting session」约两分钟后报
  「Couldn't download Claude Code」。
- 新增 `electron/asar-raw-fs.ts` 的 `asarRawFs()`：Electron 里给 `original-fs`（没改过的那份），普通 Node（单元测试、CI 同步脚本）里给 `node:fs`。
  不用 `process.noAsar`（整个进程的开关，会跟同时在读自家 app.asar 的地方抢）。改用它的地方：`claude-desktop-code-seed.ts` 的
  `readClaudeCodeBuildPin`（open）和 `pinFor`（stat）、`claude-desktop-component-manifest.ts` 的 `readClaudeDesktopComponentManifest`（open，
  Mac 放 Claude Code 和两个平台放工作区都用它）、`claude-desktop-mac-code-seed.ts` 与 `claude-desktop-workspace-seed.ts` 的 `manifestFor`（stat）、
  `codex-desktop-locale.ts` 的 `asarMemberNames`（statSync/openSync/readSync）。stat 也要换：asar 层回的大小和修改时间不变，拿它当缓存记号，
  Claude 在星芒开着时自己升级了也认不出来，会一直用旧版本号。Codex 中文资源那一处客户看不出差别：同一函数里透过 asar 层按文件夹列出来的那一支在 Electron 里本来就能用。
- 没改的：`codex-desktop-service.ts` 的 `inspectCodexDesktopAppVersion` 读的是压缩包里面的 `app.asar/package.json`，本来就该经 asar 层；
  `remove-tree.ts` 已经自带一份同样的 `original-fs` 选择，没合并过来，免得动它在 Electron 里跑的那条用例。
- 测试：`electron/asar-raw-fs.test.ts` 在真的 Electron（`ELECTRON_RUN_AS_NODE`，同 `remove-tree.test.ts`）里用 `@electron/asar` 打的包跑两个读清单的函数，
  先证明 `node:fs` 打开报 EISDIR，再证明读得出版本和工作区清单；`electron/asar-raw-fs.main-process.test.ts` 把 `node:fs` 换成照 Electron asar 层回话的替身，
  走完 Windows 放 Claude Code、Mac 放 Claude Code、放工作区三条和 Codex 中文资源检测，并钉住 Claude 升级后会重读清单。两个文件在改之前的代码上都红。
  共用的假 app.asar 在 `electron/claude-desktop-asar.test-support.ts`。
