## 用户

- AI 生成的图片、视频、音频改存到「文档」里的 XingmangAI 文件夹（「文档」在同步到 OneDrive 或 iCloud 时放在用户文件夹下），软件更新、卸载都不会动它。老版本存在软件安装位置旁边的作品，打开新版本时会自动搬过去，画布和聊天里的老作品照样能打开。
- Mac 上以前的作品存在软件包里面，更新时会跟着旧版本一起被替换掉；从这一版起改存到「文档」，更新不会再丢作品。

## 开发

- 新增 `electron/ai-output-location.ts`：`resolveAiOutputRoot` 安装版改为 `<文档>/XingmangAI`（复用 `resolveStarterWorkspaceParent` 的云同步判断，开发环境仍是项目根 `output`），`resolveLegacyAiOutputRoot` 给出老位置 `<可执行文件目录>/output`。
- `migrateLegacyAiOutput` 在启动时后台按账号数据域各跑一次：只搬 `user-<id>` 真目录，同盘整目录 rename，跨盘或 rename 失败逐文件搬（跨盘先复制到 `.moving-*.tmp` 再改名，复制完才删源）；不覆盖已有文件、不跟随链接、只搬单链接普通文件（I8）。引用只存作品编号，布局不变无需迁移任何引用。结果以计数记 `asset.output.migrated`，不记路径。
- 三个 store 写失败的文案去掉「output 目录」「安装目录写入权限」。
