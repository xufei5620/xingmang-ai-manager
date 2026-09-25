## 用户

- 装或更新工具时，进度那一行不再闪过一串英文、网址和看不懂的校验字样，只说现在在干什么：确认版本、下载、换线路、检查文件、装到电脑上、最后检查。等得久时会告诉你已经等了多久。原来的详细信息照旧留在日志里，找客服时还能用。

## 开发

- `InstallProgress` 加可选字段 `stage`（`version` / `download` / `switch-route` / `verify` / `install` / `final-check` / `raw-output`）和 `elapsedMs`，缺省 = 旧行为。`system-service.ts` 的 CLI 安装各处进度带上阶段，并补了「装到电脑上」「最后检查」两句；npm 自己的输出标成 `raw-output`，带阶段的原话（心跳与下载百分比除外）写进运行日志（`cli.install.progress` / `cli.install.output`）。
- 渲染层新增 `features/tools/install-stage-text.ts`：按阶段取固定白话；`raw-output` 只进任务日志，不改进度那一行。
