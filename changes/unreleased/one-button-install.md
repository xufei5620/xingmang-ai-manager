## 用户

- Windows 上装命令行工具（Claude Code、Codex、Gemini CLI、Grok CLI）只要点一次「安装」：电脑上缺运行环境、或者运行环境太旧认不出来，会先自动装好再接着装工具，不用再先去点运行环境那颗按钮、等它装完再回来点一次。Gemini 需要的 Python 也一起带上。新手引导「准备工具」这一步和首页都是这样。
- 安装过程中工具那一行会写清现在第几步，比如「正在准备 Node.js 运行环境（1/2）」「正在安装 Claude Code（2/2）」。
- 装失败时会说清是哪一段没装上（运行环境，还是工具本身），新手引导里多了一颗「再试一次」。
- 运行环境装完如果 Windows 要求重启，会先停下来请你重启电脑，重启后再点一次「安装」就好。
- Mac 上照旧：运行环境需要按运行环境卡里的步骤自己装，装好回来重新检测即可。

## 开发

- 第十一批候选 2。`features/tools/runtime-readiness.ts` 新增纯函数 `planCliInstall`：按快照和 `platform-capabilities` 的 `nodeRuntimeInstall` / `pythonRuntimeInstall` 算出这次安装前要先代装哪些环境（`prepare`），代装不了时返回拦截原因（`blocked`，沿用 `cliRuntimeBlockMessage`）。版本过低 / 认不出同样归入 `prepare`。
- `App.tsx` 的 `install()` 在同一个 `toolbox.run(id)` 任务里先逐个 `prepareRuntime`（每段另开 `node` / `python` 任务，运行环境卡上的进度照常走），再 `toolsApi.install`；主进程两段本来就各走 `InstallationQueue`（I11），没有新增 IPC 通道。运行环境那段失败时报「Node.js 运行环境没装上，某某还没开始安装。」加主进程原话，错误分类照旧认得出下载超时 / 磁盘满；那段期间按「取消」回一句说明，不再回「没有正在进行的安装」。
- 运行环境那段装完若带回 `systemRestartRequired`（MSI 3010），不接着装工具，直接弹 #351 的「现在重启」框；重启后再点一次「安装」只剩装工具。
- `cliRuntimeBlockMessage` 里认不出版本那句去掉了 PATH / LTS。
- `StartGuide`：`GuideToolState` 新增可选 `runtimeAutoPrepare` / `pythonAutoPrepare`（缺省 = 旧行为）。工具未装且缺的环境都能代装时进入「一颗按钮」模式：Node.js / Python 两行只报状态，「安装」不再等环境就绪；工具已装却缺环境时运行环境行仍保留自己的按钮。安装失败改用 `guideInstallErrorMessage`（不再借登录那套「连接星芒服务器超时 / 输入已保留」），并出一颗 `guide-retry`。
- `useToolbox.ts` 新增 `guideJobProgress`：引导页进度条文案取工具任务那句「第几步」，百分比借运行环境下载的进度。
- 测试：`runtime-readiness.test.ts`、`useToolbox.test.ts`、`StartGuide.test.tsx` 各补用例；`features/auth/browser-check.mjs` 新增 Gemini 一颗按钮 + 失败重试；`testing/app-check.mjs` 的 R-G6 两条按「能代装 / 不能代装」拆开，另加运行环境段失败的用例，`app-fixture.tsx` 补 `installNodeRuntime` 与 `runtimeExternal` 开关。
