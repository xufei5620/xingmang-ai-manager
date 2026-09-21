## 用户

- 「更多 → 安装卸载」页的「运行环境」里，Node.js 和 Python 这次没探出结果时会写「检测失败」并说明原因，不再显示成「尚未安装」——那会让你去重装一个其实已经装好的运行环境。

## 开发

- 运行环境两行改用 `features/tools/ToolStatusMeta` 的 `ToolStatusMeta` / `ToolStatusReason`，与工具行共用 A4 的 `toolAvailability`：探测失败 > 分区未读到 > 已安装 > 未安装，版本位缺失时按状态分别说「版本未读到」「未找到版本」。
- `ToolStatusReason` 的 `vendor` 参数改名 `lead`：这一格现在也承载运行环境行的那句说明，不再只有厂商名。
- 夹具新增 `runtimeDetectionFailed`（只让 Node.js 这一行的探针抛错，系统状态整块仍读得到），`app-check.mjs` 加一条浏览器回归，`ToolStatusMeta.test.tsx` 补运行环境行四态的 `renderToStaticMarkup` 断言。
