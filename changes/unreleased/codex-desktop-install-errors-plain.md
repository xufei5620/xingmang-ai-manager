## 用户

- Codex 桌面端装不上或更新不了时，报错改成一句大白话：说清是安装包没下好、国内下载线路连不上、线路上暂时没有能装的版本，还是这台电脑不让装；错误框里多了「去微软商店装」按钮，点一下直接打开商店里的 Codex 页面。
- 更新时国内下载线路比微软商店慢一步，会告诉你商店里已经有新版，并给出「去微软商店装」。
- 安装进度里的「Codex Desktop」统一叫「Codex 桌面端」。

## 开发

- 新增 `electron/codex-desktop-install-failure.ts`（无 Node 依赖，渲染层可值导入）：安装 / 更新失败按 blocked / damaged / unreachable / unavailable / unknown 归类，统一以「Codex 桌面端没装上：」开头；原话（SHA-256、Content-Type、商店退出码）挂在 `CodexDesktopInstallFailure` 的自有字段上随 IPC 失败日志进 runtime.jsonl，cause 保留原始错误。
- 渲染层新增错误类 `codexDesktopInstallFailed` 与动作 `openStore`；`CodexDesktopInstallResult` 新增可选 `storeNewerVersion`；`main.ts` 外链白名单的商店链接改用共享常量（值不变）。
