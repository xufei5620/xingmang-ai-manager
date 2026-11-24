# 云端容器里干活的手册

给在 Claude Code 云端容器（Linux，每个线程一个，用完就没）里开发的 agent 看。开工前读第 1 节，其余的碰到了再翻。

这些经验以前只记在云端项目的记忆里，别的线程开工时读不到，Claude·win 和本地会话更读不到，所以每个新线程都要重摸一遍。2026-11-11 把它们重新核了一遍搬到这里。

每一条后面都写了是哪天验的。**「11-11 验」是 2026-11-11 在容器里实际跑过的；「沿用」是以前某个线程记下的、这次没重演的，照做前先自己试一下。** 容器镜像会变，发现哪条对不上了，随手在自己的 PR 里改掉（见第 9 节）。

---

## 1. 开工三步

新开的容器里没有装好的依赖。不装就跑，`npm run typecheck` 会报 `TS2688: Cannot find type definition file for 'vite/client'` 这一类错，不是代码问题。

```bash
npm ci --registry=https://registry.npmjs.org/    # 约 10 秒
node scripts/ci-ensure-electron-binary.cjs       # 约 6 秒；Electron 43 起 npm ci 不带二进制，要单独装
npm run selfcheck                                # 提 PR 前的四道自查，一条命令跑完
```

（11-11 验：Node 22.23.4、npm 10.9.9、4 核；两条安装命令都一次成功。）

`npm run selfcheck` 做的事：

- 照 PR 模板「自查」一节的顺序跑 `npm run typecheck`、`npm test`、`npm run check:v2`、`npm run test:v2`。哪道红了也接着跑后面的，最后一起报。
- 容器里那份浏览器它自己认（见第 2 节），不用再手设变量。
- 结尾打印一段汇总，原样贴进 PR 的「自查」一节。没过的那道会写明完整输出存在哪个文件。
- 依赖或 Electron 没装时它一道都不跑，把上面两条命令打出来。它不替你装：`npm ci` 会先删掉 `node_modules`，有的工作目录里那是别处链过来的（见第 3 节）。

四道合起来要几十分钟，大头是 `npm test` 的 vitest 段和 `npm run test:v2` 的浏览器段。只想重跑某一道，直接敲那一条命令。

## 2. 浏览器套件

容器预装的 Chromium 和仓库的 `@playwright/test` 要的版本对不上：`@playwright/test` 1.62.0 要 `chromium-1234`，容器里装的是 `chromium-1243`（11-11 验）。直接跑会报 `Executable doesn't exist`。这是环境问题不是回归，但也不算跑过。

- 用 `npm run selfcheck` 就不用管：Playwright 自己那份不在、`$PLAYWRIGHT_BROWSERS_PATH/chromium` 在时，它替这一次运行设上 `XINGMANG_E2E_CHROMIUM`。
- 单跑某一道或某一条用例时自己设：

  ```bash
  XINGMANG_E2E_CHROMIUM=/opt/pw-browsers/chromium npm run test:v2
  XINGMANG_E2E_CHROMIUM=/opt/pw-browsers/chromium node --test --test-name-pattern=<用例名> <套件文件>
  ```

- `/opt/pw-browsers/chromium` 是容器自己放的链接，指向当前那个带版本号的目录（11-11 验）。**不要把带版本号的路径写进脚本或存好的指令里**，镜像一换就过期。
- 不要跑 `npx playwright install`（容器设了 `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`），也不要自己在 `/opt/pw-browsers` 下造软链去凑版本号。
- 不要为了让它过而改测试。门槛和别处一样：0 失败。
- **11-24 的容器带的是 Chrome for Testing 158.0.8127.36，有三条浏览器用例在 main（`69455f4`）上同样红**，不是改动弄的：`e2e/maintenance-layout.test.mjs` 的 `Maintenance actions use the content column and wrap at narrow widths` 和 `src/renderer-v2/testing/app-check.mjs` 的 `full App preserves the fixed desktop columns…`（都是取到的对齐值是 `flow-start`、断言要 `flex-start`），以及 app-check 的 `a video opened from the library is laid out at its own shape…`（放视频时页面崩了，`Target crashed`）。拿 main 的 worktree 单跑同样三条红就是这个环境问题，PR 里注明、以 CI 上 Playwright 自己那份 Chromium 的结果为准；别的用例红照旧当回归查。

## 3. 跑测试时别踩的

- **浏览器套件跑着的时候，别在同一个工作目录里合 main 或改文件。** vite 夹具会读到改了一半的文件，冒出和改动无关的红。要边跑边干别的，另开一个工作目录：`git worktree add --detach <临时目录> <提交>`，在那里重新 `npm ci`（Electron 的下载缓存共用，不用重下）。（沿用 10-26）
- **在新开的 worktree 里把主目录的 `node_modules` 软链过来省安装，有两个坑。**（沿用 11-09；`.gitignore` 那一行 11-11 验）
  1. 根 `.gitignore` 写的是 `node_modules/`（带斜杠），只挡目录、不挡软链，`git add -A` 会把这个链接提交进去。先往 `.git/info/exclude` 加一行 `/node_modules`，提交前 `git show --stat` 扫一眼。已经提交进去的那个提交别再挑回（`cherry-pick`、`merge`）主目录：git 会把主目录里真的 `node_modules` 删掉，换成一个指向它自己的坏链接，整个依赖就没了（11-11 踩过）。要挑，先在 worktree 里 `git rm --cached node_modules` 补一个提交，再连它一起挑；挑的时候加 `-n`、事后再 `git reset -- node_modules` 来不及，目录在挑的那一下就删了。真删了：从另一个装好的 worktree 把 `node_modules` 搬回来（锁文件一样才行），不然重新 `npm ci`。
  2. `tooling/legacy-renderer/node_modules` 也要链（它是 npm workspace，装着 React 18 的类型）。漏了 `npm run typecheck` 会在 legacy 的 `src/components/ui/*` 报一串类型错，不是代码问题。
  3. 链过来的依赖在 `npm test` 里会让 `scripts/renderer-single-copy.test.cjs` 红两条（`the root dev server resolves the shared packages…`、`every browser fixture server resolves the shared packages…`），报 `react resolved to <主目录>/node_modules/react/index.js`：这两条要求 React 从本目录那份解析，链接解析到了主目录，也不是代码问题。要四道全绿的结论，回主目录（或真装过依赖的目录）重跑 `npm test`。（11-21）
- **改界面字，`npm run selfcheck` 过了还要另跑一次 `npm run test:ui`**（11-21 踩过，#2063）。四道自查不含它，CI 的 linux-test 跑。`e2e/` 下除 `v2-business`、`v2-local-avatar`、`announcement-native-visual`、`canvas-close` 以外的 `*-fixture.tsx` 渲染的都是冻结的旧界面（`src/components/`、`src/App`），断言的是旧界面的字：改新界面的字时别跟着改这些用例，旧界面那边的字照旧。命令是 `XINGMANG_E2E_CHROMIUM=/opt/pw-browsers/chromium npm run test:ui`，两三分钟。
- **别用 `pkill -f <脚本名>` 收拾卡住的命令。** 命令行里带这串字的 shell 自己也会被杀掉。用进程号杀。（沿用 10-03）
- **停 `npm run selfcheck` 要停 `scripts/self-check.cjs` 那个进程，停外面那层没用**（11-21 踩过）。后台命令到时被收掉、或者杀掉 `npm run selfcheck` 那一层，里面的 `node scripts/self-check.cjs` 照样跑完四道，还往原来那个日志文件里写；这时再开一遍，两遍的输出搅在同一个文件里，汇总看不出是哪一遍的，三遍同时跑浏览器套件还冒出过跟改动无关的红（`ui/browser-check.mjs` 那条 busy Dialog 就这样红过一次，单跑是绿的）。重开之前先 `pgrep -fa scripts/self-check.cjs` 看有没有剩下的，按进程号杀掉它和它下面的 `vitest`、`node --test`。后台跑要给够时间：四道一遍在 4 核容器里一个多小时，后台命令的时限给满两小时，不然跑到第四道就被收掉。
- **要截整个新界面（首页、工具卡、错误框）**（11-21 验）：`src/renderer-v2/testing/app.html` 渲染的是完整的 `App`（首页也在），`app-check.mjs` 用的就是它。在草稿目录写个 Playwright 脚本，照 `app-check.mjs` 的 `before` 用 `e2e/harness.mjs` 的 `createFixtureServer` 起服务、打开 `…/src/renderer-v2/testing/app.html?<夹具参数>`，参数的意思在 `app-fixture.tsx` 里找 `query.get` / `query.has`。比上一条临时造夹具省事，要的状态夹具里没有，就给 `app-fixture.tsx` 加一个参数，连同一条用例一起提交。
- **`npm test` 和 `npm run test:v2` 可以在同一个目录里同时后台跑**，没冒过假红。（沿用 11-09）
- **容器里没有 zsh**（11-11 验），`electron/macos-platform.test.ts` 里真跑 zsh 的那批用例会自动跳过，不算失败。想让它们在容器里真跑，`apt-get install -y zsh`。（沿用 11-10）
- **只在 Mac 上跑的用例（`it.runIf(process.platform === 'darwin')`）可以先在容器里粗跑一遍**（11-19 验）。写一个 setup 文件，里面只有 `Object.defineProperty(process, 'platform', { value: 'darwin' })`；再写一个 vitest 配置，`root` 指向仓库、`include` 列要跑的测试文件、`setupFiles` 指向它。两个文件都放仓库外面（草稿目录），配置里别 `import 'vitest/config'`（仓库外解析不到），直接 `export default ({ root, test: { … } })`，再 `npx vitest run --config <那个配置>`。`electron/macos-grok.test.ts`、`tool-installation.test.ts`、`macos-codex.test.ts` 这样跑 134 条全过。它只对注入了假 `codesign` 的用例有意义，真去调 `/usr/bin/codesign`、`open` 的过不了也不该当真；结论以 PR 上 Mac 作业为准，PR 里写明是这样跑的。
- **首页卡片要配图时，现成的夹具截不到**（11-19 验）。`scripts/audit/v2-page-screenshot.mjs` 只收 `e2e/` 下的 `*-fixture.html`，而 `e2e/v2-business-fixture` 只渲染业务页，不渲染首页。临时在 `e2e/` 下放一对 `*-fixture.html` / `.tsx`：照 `src/renderer-v2/main.tsx` 引那几份样式（再加 `business.css`），用 `Shell` 包 `Home`，假数据照 `Home.test.tsx` 的 `render()` 写，`api` 用一个所有方法都回 `null` 的 `Proxy`。截完把这对文件删掉，别提交。
- **容器里你是 root**（11-11 验）。Linux 版客户端拒绝以 root 启动，真开客户端要先处理这个（见第 7 节）。
- **容器自带的 Claude Code（`/opt/node22/bin/claude`）以前让 `npm test` 红 29 条装工具的用例，已修**（11-18 验）：`electron/system-service.{certificate-trust,disk-space,download-stall,install-cancel}.test.ts` 的夹具现在把 PATH 换成夹具自己的目录，不再读容器的 PATH。直接跑 `npm test` / `npm run selfcheck` 就是 0 失败，不用再把那份挪出 PATH。自己写装 CLI 的用例时照同样写，见 `docs/TEST-BASELINE.md`「装命令行工具的用例：夹具要连 PATH 一起换掉」。

## 4. Electron 二进制装不上时

11-11 `node scripts/ci-ensure-electron-binary.cjs` 一次成功。它以前在容器里经代理失败过（报 undici 的 `AssertionError: assert(!this.paused)`，重试也一样）。再碰到时，用 curl 把压缩包下到 Electron 的缓存里，再让安装脚本接着装（沿用 10-03，11-11 没重演；11-21 又报了两次，脚本自己的第 3 次重试成功，先等它重试完再走下面这条）：

```bash
V=$(node -p "require('./node_modules/electron/package.json').version")
URL_DIR=https://github.com/electron/electron/releases/download/v$V
H=$(printf %s "$URL_DIR" | sha256sum | cut -d' ' -f1)
mkdir -p ~/.cache/electron/$H
curl -fL -o ~/.cache/electron/$H/electron-v$V-linux-x64.zip "$URL_DIR/electron-v$V-linux-x64.zip"
node node_modules/electron/install.js
```

缓存子目录名是「下载目录网址」的 sha256。安装脚本照常按包里的校验和核对后才解压，这条退路没有绕过校验。

**在容器里打 Windows 目录包**（比对打包前后的文件清单时用，11-20 验）：`npm run compile` 之后，
`XINGMANG_LOCAL_BUILD=1 CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --config electron-builder.config.cjs --win --x64 --dir --publish never`
能出 `release/win-unpacked`，不用装 wine。打包器自己下 win32 压缩包时经代理断在一成多（同一个 `assert(!this.paused)`），
照上面的办法把 `electron-v$V-win32-x64.zip` 用 curl 下进同一个缓存目录再打，打包器照样按 `checksums.json` 核对。
Linux 目录包把 `--win` 换成 `--linux dir`、加 `XINGMANG_LINUX_PACKAGE=1`。Mac 包不在容器里打（项目规矩）。

## 5. 容器能连哪些网站

出网都经过一个代理，只放行一部分主机。（下表 11-11 用 `curl -I` 各试过一次）

| 能连 | 连不上 |
|---|---|
| `registry.npmjs.org`（npm 官方源） | `registry.npmmirror.com`（国内 npm 镜像） |
| `github.com` 的克隆和发布包下载 | `cdn.jsdelivr.net` |
| `raw.githubusercontent.com` | `xm.solov.cc`（星芒的账号和中转站点） |
| `api.github.com` 上本仓库的接口 | |
| `nodejs.org/dist` | |
| `storage.googleapis.com` | |

- 连不上生产站点正好：自动化测试本来就不许对它发真实请求，一律 mock（`AGENTS.md` 第 1 节）。
- 以前记过还连不上的有历史账号站 `api.solov.cc`、更新服务器、OpenAI 下载站、别的仓库的 GitHub 网页（沿用 10-27，11-11 没逐个试）。
- 想在容器里真跑仓库里某段下载代码，Node 自带的 `fetch` 默认不走代理，要加 `NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt`。（沿用 10-27）
- 代理的说明在容器的 `/root/.ccr/README.md`，连不上时先看它，不要关掉证书校验。

## 6. 看 CI

- **CI 测的不是你推上去的那个提交，是它和 main 试合出来的树。** `quality.yml` 挂在 `pull_request` 上（11-11 验）。分支落后 main 时，CI 可能红在你根本没改的文件上。最省事的识别办法：把报错栈里的行号拿去和本地文件对，对不上就是落后了。先 `git fetch origin main` 看落后多少，合进来，四道在合并后的树上重跑，再推。别把「同一个失败最多重跑一次」的额度花在这上面。（沿用 09-19）
- **PR 有合并冲突时，CI 根本不会触发**，也不留任何记录，看起来像 GitHub 排队慢。推完两三分钟还没看到 `quality` 运行，先看 PR 是不是有冲突，有就合 main 解掉再推。不要推空提交去催。（沿用 09-19）
- **`quality` 运行偶尔停在 queued、一个作业都没派出来，等多久都不会动。** 跟没冲突、没被取消是两回事：运行在列表里、`jobs` 是空的，后来推的别的 PR 都照常跑。这时取消回 409「has not been queued yet」，重跑回 403「already running」，两条路都走不通。办法只有往分支上推一个真改动（合进 main 的新提交，或者把这次踩到的坑补进文档），新的那次照常派作业；不要推空提交，也不要关了 PR 再开。#1806 碰到过，推完 1 小时还是这样，靠补这一条重新推起来的。（11-12）
- **作业日志用 GitHub 工具的 `get_job_logs` 加 `return_content: true` 看。** 它给的下载链接在容器里被代理拦。最多只回最后 5000 行，`macos-test` 这种更长的日志前半段取不到。（沿用 10-05、10-06）
- **Actions 运行产物（artifact）容器里下不了。** `download_workflow_run_artifact` 给的链接在 `productionresultssa*.blob.core.windows.net`，代理拒连（403 connect_rejected）。要把产物交给人，就给运行页上那个 artifact 的链接（`https://github.com/<仓库>/actions/runs/<运行号>/artifacts/<产物号>`），对方登录 GitHub 才能下；哈希从作业日志里取。（11-18）
- **只在 Windows 上跑的用例（`it.runIf(process.platform === 'win32')`）容器里跑不到。** 想确认它在 CI 上真跑了，看 Windows 作业日志里那个测试文件的那一行，形如 `✓ legacy electron/xxx.test.ts (9 tests | 2 skipped)`，拿跳过数对一下。（沿用 10-06）

## 7. 在容器里真开客户端走一遍

**直接用 `npm run verify:app`**（11-17 验：编译完一条命令，登录加走完侧栏 13 页 16 秒）。它起的是 `npm run compile` 编出来的真客户端，不是浏览器夹具：

```bash
npm run compile                                   # 改了代码就要重编，它不替你编
npm run verify:app                                # 侧栏每一页截一张（画布除外）
npm run verify:app -- settings tap:网络连接 shot:网络连接 "expect:重开星芒后生效，不会切换账号。"
npm run verify:app -- --account api --theme dark account:keys
npm run verify:app -- --help                      # 全部选项和步骤写法
```

- 没有图形界面时它自己套 `xvfb-run -a` 再跑一遍，不用手写。
- 账号站（星芒账号、历史账号，两条线路都在）是 `e2e/verify-app-fixture.cjs` 里的假接口，余额用 `--balance` 调；别的网站一律不连，CLI 的更新检测会报「连不上」，这是故意的。假接口没答的请求列在报告里，那一屏显示「读不到」是夹具缺路由，不是产品的毛病。
- 每到一页（或 `shot:`、`look:`）存一张 `NN-名字.png` 和同名 `.txt`。`.txt` 是整页的字，滚出屏幕的部分也在，核字用它比看图准。结尾写 `report.md`（贴进真机要点的「机器能核」那段，见 `docs/COLLABORATION.md` §7.6）、`steps.json` 和这次的运行日志。默认放 `output/verify-app/<时间>`，`--out` 改位置。
- 步骤没过、页面报错（`pageerror`）都算没过，命令退出码是 1；截图照样留着，最后一张是没过那一刻。
- AI 作品文件夹不在它那个临时沙箱里：没打包的客户端把它放在仓库的 `output/`（`electron/ai-output-location.ts`，不入 git），跑完不清。假账号站不出图，平时那里是空的；自己另写脚本往里存了东西（融合第 5 步在主进程里替画布存过图），跑完删掉 `output/user-*` 和 `output/realms/`，不然下一次的作品库里会多出上一次的图。画布项目的工作文件夹在沙箱的假主目录里，随沙箱清掉。
- 下面四个坑它都处理了。自己另写脚本时照它的写法，或者直接在它上面加步骤。

它做不到的：原生对话框（选文件、保存）、系统通知和托盘菜单的样子、`title` 悬停提示的样子（`hover:` 只把提示的字记下来）、真网络、真装 CLI、真付款。这些留在真机要点的「必须真机」那段。另外工具检测照容器自己的 PATH 来：容器自带一份 Claude Code，首页会显示它装着（版本旧）。

CI 的 Windows（`windows-package`）和 Mac（`macos-test`）作业每个 PR 都跑一次不带步骤的 `verify:app`，哪一页打不开或报错，作业就红。Windows 那次的截图和每页的字在运行产物 `electron-smoke-artifacts` 的 `output/verify-app/` 里，想看 Windows 上某一页长什么样先去那里找；Mac 作业按规矩不传任何产物（`scripts/ci-workflow-config.test.cjs` 钉着），只在日志里留每一步过没过。Windows 运行机的桌面可能比要的窗口小，报告第二行写实际截到的大小。

四个不处理就走不通的地方（沿用 10-26，11-17 在 `verify:app` 里重演过）：

1. 容器是 root，`linux-launch-guard` 拒绝启动。夹具里先 `process.geteuid = () => 1000` 再加载入口。只许在夹具里这么做。
2. 出网代理会换证书。要在夹具里对 `defaultSession` 和 `app.on('session-created')` 新建的会话都设 `setCertificateVerifyProc`，只放行代理那一个签发者；装工具用的是 `fromPartition` 出来的会话，只改默认会话不够。
3. 写密钥那一步走 `Session.prototype.fetch`，不经过换掉的 `net.request`，要把它也对账号站转给假接口。
4. 容器的 PATH 里自带一份 Claude Code（`/opt/node22/bin/claude`，11-11 验；11-18 验时它链到 `/opt/claude-code/bin/claude`，不在 npm 全局目录里，客户端会当成别处装的），客户端会当成「已装好」。要走干净机器的路，给 `PATH=/usr/bin:/bin`。

另外，容器的环境变量里有一批 `ANTHROPIC_*`、`CLAUDE_*`（11-11 验）。在子进程里真跑某个 CLI 时用 `env -i` 起，否则这些变量会把它的请求带到真服务上。还有一个不带下划线的 `CLAUDECODE`：客户端探测 Claude Code 的插件列表时，它会让 Claude Code 报「cannot be launched inside another Claude Code session」退出（11-17 验）。

用 Playwright 起 Electron 时，Electron 的入口脚本里 `require.main === module` 不成立（Playwright 先加载自己的东西），按它判断「是不是被 Electron 当入口」的夹具一句都不会执行，窗口永远等不到（11-17 踩过）。改看 `process.type === 'browser'`。

只写一个 `settings.json` 种子时要带 `workspace`（非空字符串）和 `uiSkin`：缺 `workspace` 整份会被换成默认值，你种的「提示已看过」一起丢；缺 `uiSkin` 会被当成老文件、主题强制改成浅色。有了 `settings.json` 客户端就当这台机器跑过，没有 `last-run-version.json` 又会弹「已更新到…」（11-17 验）。

容器没设 `LANG`。起 Electron 时带上 `LANG=C.UTF-8`，否则碰到中文文件名会整个崩掉，只打一行 `Trace/breakpoint trap`，看着像产品的毛病。11-12 验：同一个剪贴板探针粘贴复制的 `截图.png`，不带 `LANG` 每次都崩，带上就正常；英文文件名两种都正常。

### 7.1 验证崩溃、卡住上报真发得出去（11-20 验）

`verify:app` 起的是开发态，`app.isPackaged` 是 false，崩溃上报不发。要看一条报错真从客户端发到 Sentry 那个地址、格式对不对，用一个本机假的 Sentry 接收端：

1. 给 Electron 二进制做一个**硬链接**，名字不叫 `electron`（比如 `ln -f node_modules/electron/dist/electron node_modules/electron/dist/xingmang-ai-manager`），用它起，`app.isPackaged` 就是 true。软链接不行，读到的还是原名。
2. 入口指向一个只有 `package.json`（name 写 `xingmang-ai-manager`，version 写要冒充的版本）的目录，里面的 main 再 require 夹具。直接给一个 .js 文件，`app.getVersion()` 是 Electron 自己的版本号，release 就不对。
3. 夹具在 require `dist-electron/platform/entry.js` 之前：`app.commandLine.appendSwitch('host-resolver-rules', 'MAP o4512110916009984.ingest.us.sentry.io 127.0.0.1:<端口>')` 只把 Sentry 地址指到本机，加 `no-proxy-server`；`setCertificateVerifyProc` 只给这一个地址放行自签证书；`webRequest.onBeforeRequest` 拦掉别的网址；`process.geteuid = () => 1000`（同上面第 1 条）。
4. 假接收端就是一个 `https.createServer`，把收到的每个请求体存下来。envelope 第三行是事件 JSON，看 release、environment、level、mechanism 和帧。
5. 触发：`XINGMANG_CRASH_REPORT_TEST=1` 发一条自检；`webContents.forcefullyCrashRenderer()` 是界面进程崩；卡住上报只在抽中的两成打开里发，夹具里 require 入口那一刻临时把 `Math.random` 换成返回 0 的，require 完换回来。

### 7.2 在容器里编一遍 Windows 安装程序（11-20 验）

改了 `build/installer.nsh`，容器里能用 electron-builder 的真模板把安装、卸载两半都带 `-WX` 编一遍，语法错、没人调用的函数当场红；装、卸、升级的行为容器里跑不了（没有 wine），只能靠 PR 上的 `uninstall-smoke`。

1. `node -e "require('app-builder-lib/out/toolsets/windows.js').getMakeNsisPath().then(r=>console.log(r))"` 先把 makensis 下到缓存（第一次可能断，再跑一次）。
2. 摆一个假的 `win-unpacked`：主程序 `星芒AI管理工具.exe`（随便一个 exe）、`resources/`、`locales/` 和几个文件就行。
3. 安装程序要 `!include` 打包时写出的名单 `build/installer-package-entries.nsh`（D05），`--prepackaged` 不跑 afterPack，先手动写：`node -e "require('./scripts/windows-installer-package-entries.cjs').writePackageEntriesInclude({appOutDir:'<假目录>',buildResourcesDir:'build',executableName:'星芒AI管理工具.exe'})"`。这份文件不进仓库，编完删掉。
4. 写一个小脚本：先 `require('electron-builder')`（先引 `app-builder-lib` 里的单个文件会报循环依赖），把 `app-builder-lib/out/vm/WineVm` 的 `WineVmManager.prototype.exec` 换成「往 `<安装包名>__uninstaller.exe` 拷一个随便的 exe」，再调 `build({ config: require('./electron-builder.config.cjs'), targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64), prepackaged: '<假目录>', publish: 'never' })`，环境带 `XINGMANG_LOCAL_BUILD=1 CSC_IDENTITY_AUTO_DISCOVERY=false XINGMANG_OUTPUT_DIR=<临时目录>`。卸载程序那一遍先编，假装 wine 跑完以后接着编安装程序那一遍。想看生成的整份脚本，同样换掉 `NsisTarget.prototype.executeMakensis` 把第三个参数存下来。

## 8. 仓库里的规则，云端线程读到哪些

- 根目录 `CLAUDE.md`（导入 `AGENTS.md`）每个线程开工就读。
- `.claude/rules/` 下按路径加载的那 4 份规则在云端线程里是生效的：**用读文件、改文件的工具碰到匹配路径的文件时才进上下文**。用命令行看或改（`cat`、`tail`、`sed`）不会触发。所以要动 `electron/macos-*`、`electron/linux-*`、`src/renderer-v2/`、legacy 树之前，先用读文件的工具打开一个要改的文件。（11-11 验：读和改各试一次，规则都进来了；命令行 `tail` 没触发）
- 仓库里的自定义斜杠命令、技能、钩子和 `.claude/settings.json` 的权限设置，云端项目的线程不读（官方文档，2026-11-11 查的，没逐项实测）。所以要让每个线程都照做的流程，写成 npm 脚本加文档（`npm run selfcheck` 就是这么来的），别做成命令或钩子。
- 云端项目的记忆只有云端项目自己读得到，而且每个线程开工只读索引那一页。**下一个人也会踩的开发经验写进仓库文档**，不要只记在记忆里（`AGENTS.md` 第 8 节「收尾」，`docs/COLLABORATION.md` §7.4）。

## 9. 这份文档怎么维护

- 发现哪条和现在的容器对不上：在手头的 PR 里顺手改掉，把日期换成当天。
- 新踩到一个下一个线程也会踩的坑：加一条，写明哪天验的、怎么验的。只和你这一件事有关的排查经过不用写。
- 命令、路径、版本号都要现跑现核再写，不照抄旧记录。
- 每月 1 号有一次例行整理：把云端记忆里还管用的开发经验搬进仓库文档，过期的记忆列给 yoyo 看过再清（`docs/COLLABORATION.md` §7.4）。
