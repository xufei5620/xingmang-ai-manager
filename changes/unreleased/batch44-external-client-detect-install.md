## 用户

- Windows 上，电脑里别的软件（比如 NetBeans 一类）把自己的安装记录写坏了一项时，首页没装的 WorkBuddy、Claude Desktop、OpenCode
  不再一直显示「检测失败」、只给「重新检测」，能照常显示未安装、点「安装」一键装。
- Windows 上装 WorkBuddy 时，微软的软件下载源本身出了故障（以前会报「安装没有完成（错误码 0x8a15000f）」），现在也会像连不上时一样，
  自动换成腾讯官方安装包接着装。
- Mac 上 Claude Desktop、WorkBuddy、OpenCode 没通过苹果的签名核对时，首页那一行改说「客户端数字签名无效或签名发布者与官方发布者不一致」，
  和 Windows 上同一种情况一样；以前写的是一句看不懂的「命令执行失败」。

## 开发

- 第四十四批 A：`external-client-runtime.ts` 的检测脚本用 `Get-ItemProperty` 整条读卸载信息，它会把一条记录的所有值都转换一遍，
  碰上别的安装程序写的 8 字节 REG_DWORD（NetBeans 的 NoModify 那种）整条抛「Specified cast is not valid」，以前就记「读不全」，
  三家没装的永远「检测失败」、一键安装也被拦。现在这一条退一步用 `$key.GetValue` 只读匹配要用的 DisplayName、InstallLocation、
  DisplayIcon、DisplayVersion，四个都是文字（或没有）才算读到；读不出来的（整条打不开、或坏的正是这四个之一）照旧记「读不全」、
  照旧不说没装。读不出来的记录名和 PowerShell 给的原因（最多 10 条）随结果交回，`onRegistryIncomplete` 接到运行日志
  `external-client.registry-incomplete`（原因按主目录脱敏，内容没变不重复记）。签名、路径那几道核对一行没动。
- 第四十四批 B：WorkBuddy 换腾讯官方安装包的条件，从只认 WinINet 那五个连不上的码，扩到 winget 自己的软件源坏了的
  0x8A15000F（源数据没有，多半是之前更新源没下下来）和 0x8A15003F（源数据对不上）。对过 winget-cli 源码：这两个只在打开源、
  读源里的清单时抛，安装程序还没动。安装程序已开始、客户取消、超时照旧不换；OpenCode 那句报错不变。进度用现成的那句，不新写字。
- 第四十四批 D：Mac 上 spctl 退出码 3（Gatekeeper 拒绝）、codesign 退出码 1 / 3（核对没过、不满足钉住的要求）时，首页那一行改说
  Windows 签名不对时那句现成的话（只按退出码判，不看输出）；超时和别的退出码照旧原样。哪个应用包、哪条命令、退出码、
  标准错误（截 500 字）经 `onMacVerificationFailed` 进运行日志 `external-client.mac-verification-failed`，路径按主目录脱敏，
  同一个应用包原因没变不重复记。
- 测试：`external-client-runtime.test.ts` 加读不出的记录进日志（去重、换内容再记、读全以后忘掉、最多 10 条且截长）、
  两个源坏了的码换腾讯官方（安装程序已开始不换、OpenCode 照旧报错）、Mac 上 spctl 3 和 codesign 1 / 3 换那句话并只记一次
  （放行以后再拒会再记、打开也被同一句拦）、超时和别的退出码照旧原样但照样记日志。`e2e/windows-powershell-probes-smoke.mjs`
  （Windows 打包那一步真跑 PowerShell）加两条模拟坏值的（我们不用的值坏了读得出、我们用的值也坏了照旧那句），再在本机
  当前用户下用 `reg import` 建一条带 8 字节 REG_DWORD 的真卸载信息，先证实 `Get-ItemProperty` 确实读不了它，再跑真检测脚本
  确认这条读到了、没进读不出名单，最后删掉。`system-service.external-client-log.test.ts` 把这两行日志写进一份真的运行日志
  再读回来：记录名的字段不叫 `key`（运行日志把正好叫 key 的字段当凭据打码），读回来还在，主目录已脱敏。
