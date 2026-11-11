## 开发

- `publish-release` 的 `windows-build` 上传 artifact 之后加一步「用微软自带杀毒扫安装包」（D96 / AV-11）：
  先去掉出包机器出厂带的 `C:\`、`D:\` 两条 Defender 排除，更新病毒库，拿反着存的 EICAR 测试文件
  当对照，再用 `MpCmdRun -Scan -ScanType 3 -DisableRemediation` 扫 `Setup.exe` 和 `win-unpacked`。
  只有真报毒（退出码 2）让作业失败、`publish` 不跑；Defender 起不来、对照没报出来、超时只打黄色警告，
  照常往下走。结果写在这一步的运行摘要里。在线多引擎扫描按 D96 不加。`scripts/publish-workflow-config.test.cjs` 钉住。
