## 开发

- `electron/chat-key-store.test.ts`「每个账号最多 32 个分组」原来连着做 33 次落盘原子写，Windows 跑机忙时连放宽到的 15 秒都不够（#511）。
  裁剪逻辑拆成纯函数 `pruneChatKeys` 直接测（32 个分组、16 个账号、总数 128、返回副本）；存储层用例先一次写好到上限的缓存文件，再做一次写入，确认真的按上限裁；「16 个账号」那条同样改写。去掉了那条单独放宽的 15 秒超时。
- `electron/windows-elevation.test.ts`「读当前令牌提升类型」原来真起 Windows PowerShell 现场编译 Add-Type，失败再来一次，跑机忙时仍会红（#511）。
  生成脚本拆成 `buildWindowsTokenElevationProbeScript`（行为不变），`inspectCurrentWindowsTokenElevationType` 新增只给测试用的 `platform` / `resolvePowerShell` / `run` 注入口；
  改成所有平台都跑：交给系统 PowerShell 的参数、可信环境（`NODE_OPTIONS` 被剥掉）、15 秒与 64 KiB 上限、输出解析；读不懂报错、失败原样透出；非 Windows 不问；TokenElevationType=18 与 1/2/3 的映射；here-string 与括号闭合。
