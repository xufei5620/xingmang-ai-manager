## 用户

- Windows 上装 Node.js 时，电脑里有系统更新等着重启也照样装，不再先叫你重启电脑；真要重启时，装完会提醒你。

## 开发

- `runtime-install-service.ts`：装 Node.js 前查到 Windows 在等重启（CBS `RebootPending`、Windows Update
  `RebootRequired`）不再拦下抛错，只记 `node.install.restart-pending`（带原因）进运行日志；查不清时照旧记
  `node.install.restart-probe-failed`，那行进度不再上屏。依据：Node.js 官方 MSI（`tools/msvs/msi/nodemsi/product.wxs`）
  的 LaunchCondition 只拦系统版本、没有看重启标记的自定义动作；安装带 `/norestart`，要重启时回 3010 走原有重启框，
  1603、1618、1925 原有文案已叫客户重启。原来拦法对合盖不关机、标记卡住重启了还在的电脑是死路。装工具时缺
  Node.js 自己补装那一路（`cli-install-service.ts`）本来就不查，两边现在一致。
