## 开发

- 第四十三批 E：`proxy-bypass.ts` 改直连那两条日志（`proxy-bypass.direct`、`proxy-bypass.unreachable`）带上 `failureCode`，是改直连
  之前再看那一眼经系统代理撞上的错误码。代理软件没开（ERR_PROXY_CONNECTION_FAILED）和代理开着、回绝了连星芒的请求
  （ERR_TUNNEL_CONNECTION_FAILED）归类都是 proxy，以前日志里分不出。「重新检测」那条路没再看，记 null。再看那一眼（`lookAgain`）
  的结果改成带错误码的对象，两处内部调用把错误码交给 `tryBypass`；对外的 `tryBypass()` 签名不变，判断一处没改。
- 整个改了直连以后，每 5 分钟那一眼（`restoreSystemProxy`）还是 proxy 时以前什么都不记，现在记 `proxy-bypass.still-proxy`，带错误码。
  同一个错误码一次运行只记一条，换了错误码再记一条：代理软件后来起来了、却回绝连星芒的请求，要从日志里看出来的正是这种。没网、
  说不清怎么失败的照旧不记。
- `network-failure.ts` 新导出 `networkFailureCode`：只取一个代码词，Chromium 的 `ERR_…`，或者 cause 链上挂在 code 上的 errno
  （ECONNREFUSED、EAI_AGAIN）。message 里的大写英文不算，取不到回 null，不记原文和地址。纯函数，进渲染包也不碍事（I6）。
- 第四十四批 C：`runtime-log.ts` 的 `sanitizeValue` 记 Error 时把 `cause` 一起记下。`new Error(msg, { cause })` 设的 cause 不可枚举，
  `Object.entries` 取不到，被包了一层的报错（新建项目文件夹失败、Mac 上 Claude Code / Codex / Grok 没过签名核对、npm 安装恢复失败、
  卸载回滚不完整等）日志里只有外面那句中文。cause 照样逐字段打码，受同一个深度上限（套住自己时到上限记 `[TRUNCATED]`），反馈报告
  导出时照样换掉主目录（I13）。自己用 `this.cause =` 赋值的（`RealmAccountError`）本来就记得下，不重复记。没有 cause 的错误记出来
  和以前一字不差。
- 付款窗口（`payment-window.ts`）加载失败时，cause 换成只带错误码的 `{ code }`：Electron 的原错误把整个付款地址写在 message 和 url
  上，订单号、签名都在里面（二维码那页的地址里还有付款码图片），而付款这边的日志一向只记 origin。ipc 记失败时的 `networkFailure`
  照样认得出。其余挂了 cause 的地方都过了一遍，挂的是文件、命令、下载的原错误，没有带签名或订单号的网址。
- Mac 上点「打开」「接着聊」没打开（`system-service.ts` 的 darwin 分支）、点「安装 Git」苹果的安装窗口没弹出来（`macos-git-install.ts`），
  这两处以前连 cause 都没挂，现在挂上原错误，`open` / `xcode-select` 的退出码和标准错误随这次失败进运行日志。Mac 上没有另记
  `terminal.failed`。
- 第四十三批 D（拍板第 8 条）：开机按设置定下线路以后（`main.ts` 里 `createRelayEndpointRoutingSnapshot` 那一行）记一条
  `relay.route.active`，带 `active`（这次生效的）和 `selected`（设置里选过的），只有 `primary`、`direct` 这样的 id，没有地址。
  反馈报告「运行环境」段「网络位置」下面多一行「连接线路: 默认线路」或「连接线路: 备用直连」，写当前账号那个站这次运行实际走的
  线路（`feedback-environment.ts` 新导出 `resolveFeedbackRelayRoute`，读开机时定下的那份，设置里刚改、还没重启的不算），
  词是设置里线路选择框现成的选项名，不带地址和站点名。`FeedbackRuntimeInput` 加可选 `relayRoute`，缺省时这一行不出。
- 除了反馈报告多的那一行，只多记日志：界面上不加字，联网路线和各处判断都不变。没在真机上演过。
