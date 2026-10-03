## 用户

- Mac 上 Codex 桌面端开着时，在 Codex 配置里点「信任当前文件夹」，不再弹「macOS 不支持重启 Codex」的错误框，信任照常保存。

## 开发

- 第二十九批 A 的同一个原因：`system-service.ts` 的 `trustCodexWorkspaceForService` 写完信任后只在 Windows 上替人重启 Codex 桌面端。
  Mac 主进程一律拒绝 `restart`（`codex-desktop-service.ts`），原来信任已经写进去了却抛出这句报错。
  `system-service.locale.test.ts` 钉住 Windows 照旧重启、Mac 不再请求重启。
