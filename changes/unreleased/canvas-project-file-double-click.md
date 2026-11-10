## 开发

- 画布项目文件关联到星芒，双击直接在画布里打开（D92，安装卸载.md 第 11 条）：`electron-builder.config.cjs` 按平台加 `fileAssociations`
  （Windows 的 ProgID `XingMangAI.CanvasProject`、说明「星芒画布项目」；Mac 的种类名「星芒画布项目」、`rank: Owner`；Linux 的
  `application/x-xingcanvas`，包里多一份 `/usr/share/mime/packages/xingmang-ai-manager.xml`，`verify-linux-deb.cjs` 放行并核对它和菜单文件的 MimeType）。
- 主进程收路径（`canvas-project-file-launch.ts`）：Windows、Linux 读启动参数和 `second-instance` 的 argv（Linux 的 `file:` 网址换成路径），
  Mac 接 `open-file`。只认绝对路径、扩展名 `.xingcanvas`，不认开关、相对路径和 `\\?\`、`\\.\` 设备路径；只留最近一个，十分钟没打开就作废，
  同一次双击两路都到只开一次。没登录先露出主窗口，登录好了接着开；打不开弹「没能打开画布项目」，原因进运行日志。重启和意外退出后的自动重开不再带这个文件，免得又导入一遍。
- `CanvasWindowController.openProjectFile`：先照拖放那套严查（绝对路径、`assertNoReparseComponents`、单链接普通文件，`readBoundedUtf8File` 再以 open + fstat 复核）、
  解析包，坏文件不碰开着的画布；画布开着就先走它自己的关闭确认（有任务在跑会问，用户取消就留在原项目、不导入），然后跟「导入工作流」同一个
  `importAsNewProject` 导入成新项目，画布带 `?project=<id>` 打开（内核开机读这个参数打开项目），崩溃重载不带它。一次只处理一个。
- 路径是系统交给主进程的，不经过画布页面，也不加 `canvas-host` 通道，不是 I15 说的「第二个由 renderer 提供绝对路径的通道」。
- Windows：模板 `registerFileAssociations` 写的打开命令程序路径不带引号（`C:\Program Files\…\星芒AI管理工具.exe "%1"`，装在 `D:\My Apps\` 这类位置时
  资源管理器会先试 `D:\My.exe`），`build/installer.nsh` 的 `customInstall` 每次安装（含升级）重写成 `"程序路径" "%1"`，并删掉模板那句英文
  「Open with 星芒AI管理工具」，右键显示系统自己的「打开」。`windows-installer-file-association.test.cjs` 钉住 ProgID 两边一致、模板先注册后
  `customInstall`；`windows-uninstall-smoke.yml` 新增 `windows-file-association-smoke.ps1` 真装、升级、卸载各一次核对注册表。
- 新加的界面字（报错框）：标题「没能打开画布项目」，正文「没能打开这个画布项目文件。」，按钮「知道了」；读不到文件时的说明「读不到这个文件，可能已经移走、删掉了，或者星芒没有权限读它。」；
  路径检查两句「画布项目文件路径无效」「画布项目文件不安全」（照拖放素材那两句）。其余原因沿用导入时的原话。
