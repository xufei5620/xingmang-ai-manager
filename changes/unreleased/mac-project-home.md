## 用户

- Mac 上点「新建项目文件夹并打开」，文件夹改建在个人文件夹里（访达「前往 → 个人」下的 XingmangProjects），打开 AI 工具时不用再给「终端」开「文稿」的权限。已经建好的项目原地不动，Windows 不变。
- Mac 上如果「终端」没被允许访问项目所在的「文稿」「桌面」或「下载」，终端窗口里不再是英文报错，而是两行中文说明去系统设置哪里打开，并且不会启动一个什么文件都看不到的 AI 工具。

## 开发

- `starter-workspace.ts` 新增 `resolveNewProjectParent`：macOS 一律返回主目录，Windows 仍走 `resolveStarterWorkspaceParent`。AI 生成的图片视频位置（`ai-output-location.ts`）不经过终端，仍用原函数，不搬老用户的作品。`IpcRegistrationOptions` 加可选 `homeDirectory` 供测试注入。
- macOS 终端启动脚本：`cd` 失败或进去后 `/bin/ls -A` 读不出时，打 `cli-exit-hint.ts` 里的 `macosFolderAccessHintLines` 并 `exit 1`，不启动 CLI。受保护文件夹「能进、读不出」与报错原文是推测，没在真机上复现过。
