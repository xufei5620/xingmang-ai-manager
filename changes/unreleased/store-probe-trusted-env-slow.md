## 用户

- 慢一点的电脑上「这个账户打不开商店应用」提醒不再漏掉。

## 开发

- 定位（#714）：`trustedCommandEnvironment()` 把 PSModulePath 收窄到 System32、去掉
  PSModuleAnalysisCachePath 后，Windows PowerShell 第一次自动加载 cmdlet（连 `Write-Output`
  都算）要重建整份模块分析，CI runner 上每个进程 22 秒；只查身份不碰 cmdlet 0.2 秒，放回任一
  变量 0.3 秒，脚本开头按名字显式 `Import-Module` 0.3 秒。所以商店账户探测跑满 10 秒上限返回空，
  首页和装前提醒拿不到「内置管理员」判断。
- 修法：`buildPowerShellModuleImportStatement` 在商店账户探测、商店可用性探测、Codex 桌面端合并
  探测的第一条 cmdlet 之前按名字导入要用的模块。名字仍只经收紧后的 PSModulePath 解析，没放宽任何
  环境变量，也没调大 10 秒 / 24 秒上限；导入失败退回自动加载即旧行为。
- 打包作业的 PowerShell 冒烟新增一条真检查：出货的 `inspectWindowsStoreAppLaunchContext` 在收紧
  环境、按它自己的 10 秒上限必须读出 SID；另打印商店可用性和合并探测在收紧环境下的耗时。
