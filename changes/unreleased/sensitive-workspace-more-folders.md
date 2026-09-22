## 用户

- 选择打开工具的文件夹时，如果选到了系统文件夹、存放所有用户资料的文件夹、整个 OneDrive、软件自己存数据的文件夹，或 AI 工具保存登录信息和密钥的文件夹，会先提醒一句，可以直接新建一个项目文件夹或换一个文件夹。其中系统文件夹和保存密钥的文件夹每次打开都会提醒，也不会被记住。
- 软件默认新建的项目文件夹（包括放在 OneDrive 同步的「文档」里时）不受影响，照常打开。

## 开发

- `electron/workspace-guard.ts` 新增五类：`users-root`（`C:\Users`、`/Users` 及主目录的上一级）、`onedrive-root`（`~/OneDrive`、`~/OneDrive - 公司名`）、`app-data`（`~/AppData` 及其 `Roaming` / `Local` / `LocalLow`，macOS `~/Library`）、`system`（任一盘根下的 `Windows` / `Program Files*` / `ProgramData`，macOS `/System`、`/Library`、`/Applications`、`/usr` 等）、`provider-config`（主目录下的四家配置目录，名字取自 `catalog.ts` 的 `providerConfigDirectoryNames`）。都只认目录本身，子目录放行；新增 `sensitiveWorkspacePolicy()`，`system` 与 `provider-config` 为 `every-time`，其余沿用 #321 的 `once`。
- `electron/ipc.ts`：`workspace:choose` 的选择器循环抽成 `pickWorkspace`，提示框抽成 `askAboutSensitiveWorkspace`；`every-time` 目录确认后不写进配置。`cli:launch` 对 `every-time` 目录再问一次（最近记录、续接对话、老版本记住的目录都不经过选择器），刚在选择器里确认过的同一路径两分钟内只放行一次；新对话照 #347 给「新建一个项目文件夹 / 换一个文件夹」，续接对话只给「先不打开」（`createIndex` 为 null），取消时不启动也不报错。通道形状没变，`ipc-contract.ts` / `preload.ts` / 渲染层未动；`docs/WORKSPACE-TRUST.md` 的表同步补齐。
- 第十批候选 9（A）。
