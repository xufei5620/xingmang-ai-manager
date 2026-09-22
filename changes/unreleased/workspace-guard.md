## 用户

- 打开工具时如果选中的是用户主目录、整个磁盘的根目录、桌面、下载或文档，会先提示一次
  「这个文件夹范围太大」，可以换一个文件夹，也可以仍然打开；仍然打开时不再把这种文件夹
  标成「可信」，也不再往里面生成项目说明文件，免得一份说明管住电脑上的所有项目。

## 开发

- 新增 `electron/workspace-guard.ts`：纯函数 `classifyWorkspace` 判定「主目录 / 盘根与卷根 /
  桌面 / 下载 / 文档」五类敏感工作目录，Windows 与 macOS 大小写不敏感，认 OneDrive 的已知
  文件夹重定向（含简体中文的「桌面」「文档」「下载」与企业版的 `OneDrive - 公司名`），
  判不准时一律按普通目录放行。
- `workspace:choose`（`electron/ipc.ts`）选到这几类目录时先弹一次中文提示，「换一个文件夹」
  会把选择器再打开一次，「仍然打开」照常返回并记一条 `workspace.guard.accepted`（只记类别，
  不记路径，I13）；通道形状没有变化，渲染层与 `preload.ts` 不受影响。
- `launchProviderOperation`（`electron/system-service.ts`）对这几类目录跳过 `trustManagedWorkspace`
  与 `ensureProjectInstructions` 两段，记一条 `workspace.guard.skipped`；记住的目录（N7）走的是
  同一段，老用户已经记住的主目录再打开也不会补写。Gemini 的 `context.fileName` 属于用户级配置，
  不在跳过范围内。
