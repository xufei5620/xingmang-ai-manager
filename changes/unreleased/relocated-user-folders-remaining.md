## 用户

- 用户文件夹或「文档」被挪到别的盘的电脑，画布里生成和导入的图片、视频、音频现在能正常显示、另存和删除，画布项目也能选在「文档」「桌面」里；Codex 的会话记录能打开、归档和恢复；Codex 的外接工具和技能开关能正常读写。和上一版一样，以管理员身份运行时仍然不跟过去。

## 开发

- 把 #452 的「C 盘搬家」例外接到剩下几处自带路径检查的模块，全部复用 `resolveRelocatedPath`，不另起规则：画布资产读回（`ai-asset-store` / `ai-video-asset-store` / `ai-audio-asset-store` 的有界读取与 `resolveOwnedFilePath`）、画布项目工作文件夹（`canvas-project-store` 的 `normalizedWorkspaceDirectory`）、Codex 会话（`codex-sessions` 的 `isInside`：Codex 会把我们注入的 `CODEX_HOME` 规范化，搬家机器上 `rollout_path` 记的是新位置，先按字面比、不在里面再两边都换成实际位置比）、Codex 外接工具与技能（`codex-extensions` 的 `assertNoSymlinkComponents`）、技能 Git 目录（`provider-extensions` 的 `plainGitDirectory`）。都是先换成实际位置再照原样严查；策略没开（`trusted-only`、root、启动探测未定）时 `resolveRelocatedPath` 等价于 `path.resolve`，行为与之前一字不差。`canvas-v2/` 未改动。
