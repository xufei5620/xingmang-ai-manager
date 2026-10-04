## 用户

- Windows 上 Codex 桌面端从 OpenAI 官网下载离线安装包时，下了半分钟以后照当时的速度还要 10 分钟以上才下得完，就自动换国内线路接着装，
  不用再点「取消」（点「取消」会把整次安装停掉）。

## 开发

- 0.2.15 发版前回归检查第三节③：`codex-desktop-service.ts` 的官网离线包这一路以前没有慢的出口，下得慢只能点取消，而取消会停掉整轮安装，
  到不了国内镜像。现在 `downloadCodexDesktopPackage` 按来源的 `maximumRemainingMs` 看速度：过了 30 秒的观察期，每个数据块按平均速度估算
  剩下的还要多久，超过 10 分钟就用另一个 AbortController 中止这一路，抛「OpenAI 官网下载太慢：照目前的速度还要 N 分钟才下得完」，
  走原来「官网没下成就换国内镜像」那条路（进度用已定稿的那句）。按剩余时间算，前面慢过、只差最后一点的不扔掉重下；国内镜像是最后一路，
  不设这个限制。客户点取消照旧整次停下。新增 `estimateCodexDesktopDownloadRemainingMs`、`isCodexDesktopDownloadTooSlow` 两个纯函数。
- 回归检查第三节④：外部客户端（Claude Desktop、WorkBuddy、OpenCode）的安装以前没有取消通道，Claude 官网包（Windows MSIX #804、
  Mac #802）下得慢时还占着全局安装队列。`external-client-runtime.ts` 接入 `InstallCancellationRegistry`，入队前登记，新增 IPC 通道
  `external-clients:cancel-install`（`ipc-contract.ts`、`preload.ts`、`ipc.ts` 三处，注册紧跟 `external-clients:install`）。排队、官网下载、
  核对安装包都能停；Windows 上 winget 整段（结束它会连带结束它拉起的安装程序）、下好的 MSIX 交给 `Add-AppxPackage`、腾讯安装程序运行时
  封存，拒绝时给「正在安装 X，这一步中断会留下装了一半的程序，请等它结束。」；winget 没装上、换官网包那一路时解封。Mac 全程不封存：
  放进「应用程序」是整个改名，跨盘时先拷到临时名字再改名。`claude-desktop-msix-installer.ts`、`workbuddy-installer.ts` 各加一个
  `onInstallStarting`，在最后一次检查 signal 之后同步调用，供调用方封存。取消统一抛 `InstallCancelledError`（「X 安装已取消」）。
  首页那颗「取消」按钮要加界面文字，等确认后另开 PR；在那之前这条通道没有调用方，客户看到的行为不变。
- `download-retry.ts`：每次读到数据块后先看这一轮有没有被中止。响应体不跟着请求信号一起中止时（测试里的流、不接信号的 fetch 实现），
  流里排着的数据块会赢过中止，取消或「太慢」要等排队的数据读完才生效；整包都排在流里时甚至照样当成下完返回。
