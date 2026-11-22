## 开发

- 手机遥控「接对话」不再只认 Codex 0.169.x（0.2.25 第三轮复查第 4 条）：0.169.0 及以后的版本都开放，每次接上已有对话时先用 `thread/settings/update` 写进遥控规矩，再 `thread/resume` 一次核 Codex 报回的 `collaborationMode.settings.developer_instructions` 一字不差，核不上（字段被改名时 Codex 照样回成功）或 Codex 以 -32600/-32602 拒收，就对手机和电脑页说「当前 Codex 版本暂不支持继续已有对话」，消息不交给 Codex，这一版本在本次运行内记下不再试。规矩改在接上时写一次，第一句的 `turn/start` 不再带 `collaborationMode`。0.169.0 与 0.171.0（npm 最新）在沙箱 app-server 上实测：写入、报回、下一句发给模型的请求、换型号后、重开进程再接，两版一致。`docs/CLI-VERIFIED-VERSIONS.md` 巡检步骤加了抬 Codex 前重核接对话这一步。新字没有，沿用 11-22「接对话字改」确认过的原话。
