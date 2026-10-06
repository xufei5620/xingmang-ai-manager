## 用户

- 首页一个工具第一次点「打开」（这个工具没聊过、星芒里也没选过文件夹）时，不再弹选择文件夹的窗口，直接建好
  「文档\XingmangProjects\my-project」在里面打开（Mac 建在个人文件夹下的 XingmangProjects；「文档」被云盘接管或写不进时也放个人文件夹）。
  想用自己的文件夹，点那一行的「⋯」→「选择其他目录…」。建不成时照旧先说「没能替你新建项目文件夹。」，接着弹选择窗口。
  打开过一次以后按钮写「打开 my-project」，旁边的下拉和以前一样。

## 开发

- 已知40：`Home.tsx` 的 `startsFresh`（会打开目录的 CLI、最近记录已读到且这个工具一条都没有、也没记住的目录）时「打开」走
  `onLaunchInNewFolder(tool, true)`，「⋯」里的新建入口换成 `chooseWorkspaceLabel`；记录还没读到时照旧弹选择框。
  `ChooseWorkspaceOptions` 加 `fallbackToPicker`，`workspace:choose` 建不成时说完接着走 `pickWorkspace`；
  `App.tsx` 的 `launch` / `requestLaunch` 把 `newFolder` 布尔换成 `LaunchFolder`（`choose` / `create` / `createOrChoose`）。
  托盘、Ctrl+1～5、引导里的打开不变。
