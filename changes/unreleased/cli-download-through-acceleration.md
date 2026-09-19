## 用户

- 修复开着本机加速时安装 CLI 却下载不动：安装用的下载以前从不经过加速线路，开不开加速都是直连，
  所以加速对「下载慢」这件事一直没有作用。现在下载和 npm 都会跟着当前生效的代理走，机器上配了
  公司代理的用户同样受益。
- Grok CLI 下载长时间没有新数据时，安装日志会每 15 秒说明已经静止了多久，不再只停在一个不动的百分比上。

## 开发

- 新增 `electron/download-proxy.ts`：解析 Chromium `session.resolveProxy` 的结果，产出下载用的代理端点，
  以及给包管理器子进程的 `HTTP(S)_PROXY` / `NO_PROXY`。只取列表首项（Chromium 自己会走的那条），
  无法识别的一律按直连处理。
- `createSystemService` 新增 `downloadFetch` 与 `resolveSubprocessProxyEnvironment` 两个注入点，`main.ts`
  分别接到 `net.fetch` 和 `session.defaultSession.resolveProxy`。Grok 二进制下载与 Node.js LTS 下载以前用
  全局 `fetch`（Node 自带网络栈不读系统代理），npm 子进程则完全没有代理变量，两条路都是直连出去。
- 子进程只接受**回环**代理：Windows 安装路径会跨提权边界执行 npm，而系统代理是普通用户可改的设置，
  把任意远端代理交给提权子进程等于让那个设置决定包从哪来。远端系统代理仍然作用于进程内的下载——
  那里由 Chromium 在本进程内终止连接，且每个产物都有签名与摘要校验。
- `scripts/verify-packaged-hardening.cjs` 新增 `assertNoDefaultAppFallback`：打包产物的 `resources/` 里不得
  残留 `default_app.asar`，那是 Electron 找不到应用归档时的回落入口，会自己开窗口。
