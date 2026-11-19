## 开发

- 新同步作业 `sync-claude-components-cos`（每 6 小时，也可手动跑）：把 Claude Desktop 的 Cowork 工作区（四个平台）
  和 Mac 上的 Claude Code 程序包从 downloads.claude.ai 原样搬进存储桶 `xingmang/offline/claude-components/`。
  Windows 工作区读 Windows 商店版 x64 安装包里的清单，Mac 工作区和 Mac 程序读 Mac 通用版 zip 里的清单（两边版本
  不同步，11-19 是 5.11492.5 和 6.6395.1）；大小和 SHA-256 对上清单才传，不可覆盖、完整回读、HEAD 复核，连续两次
  定时失败开 issue。读清单和算桶里位置的代码在 `electron/claude-desktop-component-manifest.ts`（读 asar 的几个工具
  跟 `claude-desktop-code-seed.ts` 共用）、`claude-desktop-component-keys.ts`，客户端以后用同一份。客户端去桶里取、
  放进 Claude 文件夹的那部分随 0.2.25 另行合入，在那之前桶里这些文件没有客户端在用。
