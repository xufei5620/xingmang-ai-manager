## 用户

- 检查页「查看详情」改成中文说明（例如「以管理员身份运行：否」），不再列一串英文字段名；站点地址、状态码这类只对客服有用的内容不再显示，导出的检查报告里照旧都有。
- 连接自检失败时不再把请求地址摆在界面上；服务返回的原话收进一个可展开的小框，联系客服时可以附上。
- 检查页的「去处理」只在软件里真能处理时才出现：网络相关的几项直接打开设置里的「网络」，不再停在「外观」；磁盘空间、系统版本、运行权限、系统里的环境变量这类软件替不了你的项，不再把你带到无关的「安装卸载」页。Git 那一项改去首页的「运行环境」。

## 开发

- 新增 `features/app/diagnostic-details.ts`：`diagnosticDetailRows` 只把白名单里的 details 键译成中文上屏，布尔值译成是/否，null、未知键、含网址的值、`reason` 的英文代号一律不显示；`endpoint` / `baseUrl` / `status` / `executionMode` / `probeFailure` / `required` 刻意不列。导出报告不受影响。
- `diagnosticTarget` 改为返回 `V2Page | null`，去掉兜底的 `'maintenance'`；`diagnosticHasFix` 改为「有落点才有按钮」。`PROVIDER_ENVIRONMENT_OVERRIDE` 不再给按钮（设置页没有对应开关）。
- 新增 `features/app/settings-group-intent.ts`：跳设置页前 `requestSettingsGroup('network')`，设置页挂载后在 effect 里 `takeSettingsGroup()`（不放 useState 初始化函数，严格模式会跑两遍）。
- 检查页连接自检结果条不再渲染 `view.endpoint`；`view.detail` 放进默认收起的 `<details>`。
