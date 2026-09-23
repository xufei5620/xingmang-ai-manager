## 用户

- 界面上又去掉了一批技术说法：引导页的「Node.js 与 npm」改叫「运行环境」；设置里「npm 全局包装到哪」改成「工具装在哪里」、「从旧版本迁移」改成「以前的设置」、「更新通道：未签名」改成「更新方式」；「使用统计」写明目前不会收集任何记录。
- 检查页网络一项通过时只写「能连上星芒服务」，不再带状态码；连接自检的归因标签「分组与渠道」「协议与端点」改为「账号分组」「连接方式」。
- 反馈页日志的级别显示成「错误 / 提醒 / 信息 / 调试」，和上面的筛选一致。
- Codex 桌面端「查看文件夹权限」用中文说明信任状态；外部客户端配置里 OpenCode 的选项改成「Codex / GPT 系列模型 / 其他模型」，WorkBuddy、Claude Desktop 的说明去掉了接口名。

## 开发

- 只改文案与显示映射，逻辑不动：`connectionLayerLabels` 与主进程 `connectionCheckLayerLabels` 同步改名（反馈报告里的归因说法随之变化）；`XINGMANG_NETWORK` 的 summary 去掉 `HTTP ${status}`，状态码仍在 details 与导出报告里；反馈页级别 Pill 用 `runtimeLogLevelLabels`，未知级别原样显示。
