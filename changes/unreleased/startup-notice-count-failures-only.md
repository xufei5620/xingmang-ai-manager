## 用户

- 开机那条「环境检查发现 N 项需要处理」只数真正要处理的项了。没装用不到的工具、Python 或 Git 这类只需留意的情况不再每次开机都提，检查页里照旧标黄；和要处理的项一起出现时，提示里只带一句「另有 N 项可留意」。

## 开发

- `startupDiagnosticsIssues` 改收 `report.counts`，只把 `fail + error` 计入标题；只有 `warn` 时返回 null，同时有 `warn` 时正文补一句。`diagnostics.ts` 的级别判定没动。浏览器夹具新增 `diagnosticWarnings`，`diagnosticIssues` 改为计入 `fail`（第八批候选 2）。
