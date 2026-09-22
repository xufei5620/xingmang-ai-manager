## 用户

- 打开工具时选到桌面、文档这类「范围太大」的文件夹，提示框的第一个按钮（直接回车就是它）变成
  「新建一个项目文件夹」：软件替你在「文档」里建一个空的项目文件夹并直接打开，不用再选、不用起名，
  和选了一个普通项目文件夹一样替你标成「可信」、生成项目说明文件。「文档」被 OneDrive 或 iCloud
  同步时改建在用户目录下，免得 AI 写的文件和装的依赖被一直上传、拖慢电脑。

## 开发

- 新增 `electron/starter-workspace.ts`。`resolveStarterWorkspaceParent` 选上层目录：优先
  `app.getPath('documents')`；Windows 上文档路径带 `OneDrive` / `OneDrive - 公司名` 一段、或落在
  `OneDrive` / `OneDriveConsumer` / `OneDriveCommercial` 环境变量指的目录里，macOS 上 iCloud 云盘
  容器里有 `Documents`（「桌面与文稿」已打开），以及文档不存在、不是绝对路径时，一律退到用户主目录。
- `createStarterWorkspace` 在上层目录的 `XingmangProjects/` 里建 `my-project`、`my-project-2`……
  名字刻意用 ASCII、不带空格和括号（中文 Windows 上下游工具对非 ASCII / 括号路径的兼容没法逐个
  真机验证）。容器走 `ensureSafeDataDirectory`，候选名用不带 `recursive` 的 `mkdir` 抢（撞名即
  EEXIST 顺延，不先查后建），建成后 `assertNoReparseComponents` 复核整条路径（I8）；已有同名一律
  不复用，最多顺延到 99；上层目录不存在时不替用户建；新目录先过 `classifyWorkspace`，落进敏感
  名单就拒绝；系统错误的英文原文换成中文。
- `buildSensitiveWorkspacePrompt`（`electron/workspace-guard.ts`）多一个按钮与 `createIndex`，
  按钮顺序变为「新建一个项目文件夹 / 换一个文件夹 / 仍然打开」，「新建」是默认按钮（新手少做决定），
  直接关掉对话框（`cancelId`）仍等于「换一个文件夹」。`isOneDriveContainer` 改为导出。
- `workspace:choose`（`electron/ipc.ts`）处理新按钮：建好直接当作这次的工作目录返回，信任写入与
  AGENTS.md 生成照常；建不成弹一句中文说明再回到选择器。日志 `workspace.starter.created` /
  `workspace.starter.failed` 不记路径（I13）。「文档」位置由新的可选项
  `IpcRegistrationOptions.documentsDirectory` 注入，`main.ts` 传 `app.getPath('documents')`。
  通道形状没变，`preload.ts`、`ipc-contract.ts` 与渲染层都没动。
