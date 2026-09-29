## 用户

- 「文档」文件夹不让本软件写的时候（比如开了 Windows 安全中心的「受控文件夹访问」，或者安全软件开了文档保护），点「新建项目文件夹并打开」不再只报一句「可能是没有写入权限」，而是自动建在个人文件夹里的 XingmangProjects，并弹一句说清楚放在了哪，附「打开文件夹」按钮。已经建好的项目原地不动；磁盘满这类情况照原来提示。
- AI 生成的图片和视频同理：「文档」不让写时，下次打开软件自动改存到个人文件夹里的 XingmangAI，生成前照旧先试写、写不进不扣费。以前存在「文档」里的作品不搬。
- Windows 的「检查」页多一行「「文档」文件夹能不能写」，写不进时说明常见原因，并给「打开文件夹」；「AI 作品保存位置」一行换过地方时也照实说作品在哪。

## 开发

- 新增 `electron/documents-fallback.ts`：`isWritePermissionError`（顺 cause 链认 EPERM / EACCES）、`probeDirectoryWritableSync`、`createStarterWorkspaceWithFallback`（建好后在新文件夹里再试写一次，不让写就删掉空文件夹改建到主目录）、`inspectDocumentsWritability`、`buildDocumentsFallbackPrompt`。`createStarterWorkspace` 包中文错误时把原始错误挂在 `cause` 上。受控文件夹访问报哪个错误码、是否放行建文件夹都是推测，没在 Windows 真机上抓过。
- `ai-output-location.ts` 新增 `chooseAiOutputRoot`：启动时在「文档」下建目录并试写，权限类失败改用主目录下的 XingmangAI（按账号 scope 两边都套）；`main.ts` 用它替代直接的 `resolveAiOutputRoot`，业务对象多带 `aiOutputPlacement`。
- 诊断新增 `DOCUMENTS_WRITABLE`（只在 Windows、宿主给了 `documentsDirectory` 时），`AI_OUTPUT` 换过地方时在 details 里标 `openFolder`。
- 新 IPC 通道 `diagnostics:open-folder`（`openDiagnosticFolder`），入参只收 `'projects' | 'ai-output'`，路径由主进程算，打开前过 `ensureSafeDataDirectory`；`IpcRegistrationOptions` 加可选 `aiOutputDirectory`。
