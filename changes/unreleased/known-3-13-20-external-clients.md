## 用户

- 开机以后，首页 WorkBuddy、Claude Desktop、OpenCode 那几行不再空着等十几到二十几秒：先摆出上次检测的结果，同时照旧写着
  「正在检测 WorkBuddy、Claude Desktop 和 OpenCode」，这时那几行的按钮先不能点；这次的检测结果一回来就换上，按钮恢复。
- Windows 上检测桌面客户端时读不出安装信息或数字签名，首页那一行只说那句中文原因，不再在后面拼一段系统给的英文。
- Claude Desktop 每保存一次配置，都会给改到的每个文件留一份备份，以前从来不清，旧 Key 一直留在里面；现在每个文件只留最近 5 份。

## 开发

- 已知3：`external-client-runtime.ts` 的检测脚本在 AppX 注册信息、数字签名两处 catch 里把 `$_.Exception.Message` 直接拼在
  中文后面，首页那一行就带着系统英文。现在 `errors` 只留中文那句，原话另放 `errorDetails` 交回，经 `onDetectionErrorDetail`
  进运行日志 `external-client.detection-error-detail`（路径按主目录脱敏；同一个客户端原因和原话都没变不重复记；这一行最后
  报的是这边核对路径、签名时另起的错时不配这句原话）。不新写字。
- 已知13：照 CLI 那份 `system-snapshot-cache.ts` 的做法，新增 `external-client-snapshot-cache.ts`：每次真检测完把三家各一条的
  整份结果写进本机数据目录的 `external-client-snapshot.json`（原子写、只认三家齐全的整份、`running` 一律记成没开、字符串过
  `redactCommandText` 并截长、下载页只认白名单那一条），下次开机首页先拿它把那几行画出来，每条带 `cachedAt`。要落盘的字段
  用类型钉住（必填字段连同类型、可选字段名，改了就过不了类型检查，提醒加格式版本号）。读取复用 `external-clients:scan`，
  第二个参数 `{ cachedOnly: true }`（入参严格校验），不新增通道；这一读只读本机文件，不陪账号恢复排队、不起盘点、不记检测
  失败；本次启动真检测过以后只回空列表。首页见到 `cachedAt` 就当作还在检测：主按钮、「配置」「打开」先不能点，挂着现成的
  「正在检测 WorkBuddy、Claude Desktop 和 OpenCode」那一句；真的那轮照旧排在首屏扫描之后，回来就整份替换，没读到就撤下
  旧的、只留原来那条红条。主进程里安装、打开、配置、连接自检、反馈报告都不读这份文件。
- 已知20：`claude-desktop-local-transaction.ts` 每次保存给改到的每个文件留 `.bak.<随机>`，以前从来不清。现在整次保存成功
  以后，照 `config-files.ts` 每个文件只留最近 5 份：只认自己起的 UUID 后缀，按修改时间排，刚留的那份不删，手工放的 `.bak`
  和别的文件不碰，删经 `removeSafeDataFileSync`，清不掉的照旧留着、不把保存变成失败；保存没成功时一份不删（那句报错要客户
  从 .bak 恢复）。
- 测试：`external-client-runtime.test.ts` 加脚本那两句不再带原话、原话进日志且只记一次；`system-service.external-client-log.test.ts`
  把这行日志写进真的运行日志再读回来（主目录已脱敏）；`e2e/windows-powershell-probes-smoke.mjs`（Windows 打包那一步真跑
  PowerShell）加 AppX 和数字签名两处抛错时 `errors` 只有中文、原话在 `errorDetails`。新增 `external-client-snapshot-cache.test.ts`
  （往返、只认整份、脱敏和多余字段、坏行和白名单外的下载页、类型钉、原子写和只读一次、硬链接拒读）；
  `external-client-service.test.ts` 加重启后先给上次结果、真检测过以后只给空列表；`ipc.test.ts` 加这一读不陪账号恢复排队、
  参数格式不对报错；`claude-desktop-config.test.ts` 加每个文件只留最近 5 份、保存没成功时一份不删。新界面浏览器回归加开机先摆
  上次结果且按钮等着、真的那轮没读到时撤下旧的；原有「客户端盘点排在首屏扫描之后」那条改成只数真检测。
