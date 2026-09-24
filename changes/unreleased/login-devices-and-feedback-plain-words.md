## 用户

- 个人中心「登录设备」不再显示一长串英文标识，改成「星芒AI管理工具 0.2.10 · Windows 电脑」「Chrome 浏览器 · Mac」这样的说法，认不出来的写「其他设备」。
- 反馈页的日志来源改成「账号」「加速」「安装卸载」这类说法，不再露出 ipc 之类的英文；网络出错时标题后面括号里重复的那半句去掉了，原文仍在「详情」里。

## 开发

- `features/account/login-device-label.ts`：只在显示层把登录会话的 User-Agent 认成大白话，发给服务端和服务端回来的原文都不动。
- `features/app/runtime-log-filter.ts`：新增 `runtimeLogArea`（source + event → 侧栏叫法；source 为 ipc 时按通道前缀认），「全部来源」下拉改按这个叫法筛选，选项从已加载的条目里取；`runtimeLogDisplayMessage` 去掉网络失败文案后面括号里的排查现场。复制这一条、导出报告的格式不变。
