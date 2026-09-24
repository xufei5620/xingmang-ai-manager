## 开发

- `electron/codex-desktop-service.test.ts` 里两条只在 Windows 上跑的 MSIX 读取用例（读出身份字段与签名项、清单超 1 MiB 在解析前拒绝）
  原来先用 Compress-Archive 现场打一个 MSIX 再交给真 powershell.exe，一条用例两次冷启动，run 35809812859 里读取那一步被自己的 90 秒预算杀掉。
  现在拆成所有平台都跑的三条：注入 `run` / `resolvePowerShell` 检查交给 PowerShell 的参数、可信环境与超时，并把输出解析回元数据；
  用 #454 的引号扫描器检查带恶意字符的安装包路径只出现在单引号字面量里、清单大小检查排在解压之前、XML 读取禁 DTD 与外部解析；
  输出读不懂时报「无法读取」、PowerShell 自己拒绝时原样透出。生成脚本拆成 `buildCodexDesktopPackageInspectionScript`，行为不变。
