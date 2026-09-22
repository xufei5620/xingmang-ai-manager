## 用户

- 首页每个工具行的「…」菜单里多了一项「打开配置文件夹」，点一下直接在资源管理器 / 访达里
  打开这个工具自己的配置目录（Claude Code 是 `.claude`，Codex CLI 与 Codex 桌面端共用一份
  `.codex`，Gemini 是 `.gemini`，Grok 是 `.grok`），不用再照着界面上的路径手敲——这些
  `.` 开头的目录在资源管理器和访达里默认都看不见。还没写过配置的工具这一项是灰的，写着
  「还没生成」，软件不会替你先建一个空文件夹；只打开文件夹，不动里面任何内容。

## 开发

- 新增 IPC 通道 `config:open-directory`（`openProviderConfigDirectory`）：主进程按
  `providerConfigRoot` 解析目录后交给 `externalShell.openPath`，与反馈页的
  `runtime-logs:open-directory` 同一条路径。三份通道表（`ipc-contract.ts`、`preload.ts`、
  `ipc.ts` 的注册顺序）同步（T1）。
- 新增 `electron/config-directory.ts`：`assertOpenableConfigDirectory` 在交给外壳之前做
  reparse 与「普通目录」校验（I8，配置目录在用户可写区，一个联接就能让资源管理器打开别处），
  目录不存在时报中文「还没有生成」而不是 `ensureSafeDataDirectory` 那样顺手创建。
- `registerIpcHandlers` 多一个可选 `providerRoots`，`main.ts` 传入
  `rootedOptions.system.providerRoots`，Codex 因此跟随软件注入的 `CODEX_HOME` 而不是写死
  `~/.codex`；省略时按当前进程环境推一份，等于旧行为。
- 渲染层：`ToolPresentation` 多一个 `configDirectoryReady`（取主进程已有的
  `dataDirectoryExists`），纯函数 `configDirectoryMenuItem` 出菜单项文案与置灰状态，
  `Home.tsx` 的工具行菜单与 `App.tsx` 的 `perform('打开配置文件夹')` 接线。四个 CLI 与
  Codex 桌面端五行都有这一项。配置分区整块读失败时写「配置暂未读到」而不是「还没生成」——
  那一遍根本没读着目录状态，不能替它断言。
