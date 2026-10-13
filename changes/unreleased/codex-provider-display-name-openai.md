## 用户

- Codex 桌面端左下角的线路名从「XingmangAI」改成「OpenAI」。以前的对话、登录状态和选好的型号都不受影响。

## 开发

- Codex 线路显示名（`[model_providers.XingmangAI]` 的 `name`）改成 `OpenAI`，表名照旧 `XingmangAI`（续接列表按表名筛，改了老对话就看不见）。新装模板直接写 `OpenAI`；合并保存和开机补模板缺省项（`relayTemplateRevision` 升到 3）只换星芒自己那张表（地址是已登记站点）上一字不差的老值 `XingmangAI`，客户自己改过的名字、别人写的表、8-26（#104）以前就叫 `OpenAI` 的老配置都不动；`config.toml` 和 `xingmang-config-relay.toml` 一起改，改前照样备份。CLI 巡检脚本（`scripts/probe-cli-relay.cjs`）写的探测配置同步改成 `OpenAI`，让探测的请求体和客户的一样。
- Codex 认官方线路看的是 `name == "OpenAI"`（区分大小写，不看地址），对上就把长对话压缩改走远程 `/responses/compact`，CLI 的 `/model` 还会多一行 base URL 被改写的红字。yoyo 2026-10-13 选大写之前，已在星芒中转上实测命令行 `/compact` 和桌面端压缩，星芒账号和历史账号都通；new-api rc.24 源码也有这条转发路由（`router/relay-router.go:104`）。调研见项目文件「Codex左下角名字/调研.md」。
