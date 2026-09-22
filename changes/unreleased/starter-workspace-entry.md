## 用户

- 首页工具那一行多了「新建项目文件夹并打开」：还没用过的工具在「更多操作」里，用过的在「打开」旁边的下拉里。点一下软件就替你在「文档」里建好一个空的项目文件夹并直接打开，不用再选。
- 首次使用引导的最后一步多了一句「选哪个文件夹」：不知道选哪个，就点「新建并打开」。

## 开发

- `workspace:choose` 多一个可选参数 `{ createStarter: true }`（`ChooseWorkspaceOptions`，`electron/ipc-contract.ts`）：不弹选择器，直接走 #347 那套 `createStarterWorkspace`，建好照常写进设置并返回路径。参数按白名单校验，只认这一个布尔键，渲染层给不出路径（I5）；没加新通道，`ipcInvokeChannels` 顺序不变（T1）。
- 渲染层：`workspaceChoices` 末尾多一项 `create: true`；`Home.tsx` 的下拉与（没有最近目录时的）「更多操作」菜单接 `onLaunchInNewFolder`；`App.tsx` 的 `launch` / `requestLaunch` 多一个 `newFolder` 参数；`StartGuide.tsx` 完成步给四家 CLI 加一行说明和「新建并打开」按钮，Codex 桌面端与聊天不给。
