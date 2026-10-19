## 用户

- 在国内的 Windows 电脑上一键安装 Node.js，不再先用系统自带的应用安装组件从国外慢慢下、最长要等 15 分钟，而是直接从国内镜像下载经过校验的安装包；海外照旧。

## 开发

- Node.js 自动安装的 winget 那一步按网络位置决定（#1061 第 5 条 winget 那半）：`node-runtime.ts` 新增 `nodeRuntimeTriesWingetFirst`，只有网络位置明确在海外才先试 winget；在国内或测不出位置时直接走 MSI，镜像排第一（测不出位置跟国内一样，同 `nodeRuntimeDownloadSources` 的理由）。位置在没借下载专用线路时问一次，借到线路后照旧再问一次定先走哪个源（第二十八批 D 不变）。没选「给 winget 一个短时限」：到点杀进程树杀不到它提权拉起的 msiexec，Windows Installer 还在装，后面 MSI 那一步会撞 1618。跳过的原因进运行日志。不碰提权、可信路径和命令执行，只改试不试 winget。
