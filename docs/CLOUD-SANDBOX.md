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

## 3. 跑测试时别踩的

- **浏览器套件跑着的时候，别在同一个工作目录里合 main 或改文件。** vite 夹具会读到改了一半的文件，冒出和改动无关的红。要边跑边干别的，另开一个工作目录：`git worktree add --detach <临时目录> <提交>`，在那里重新 `npm ci`（Electron 的下载缓存共用，不用重下）。（沿用 10-26）
- **在新开的 worktree 里把主目录的 `node_modules` 软链过来省安装，有两个坑。**（沿用 11-09；`.gitignore` 那一行 11-11 验）
  1. 根 `.gitignore` 写的是 `node_modules/`（带斜杠），只挡目录、不挡软链，`git add -A` 会把这个链接提交进去。先往 `.git/info/exclude` 加一行 `/node_modules`，提交前 `git show --stat` 扫一眼。已经提交进去的那个提交别再挑回（`cherry-pick`、`merge`）主目录：git 会把主目录里真的 `node_modules` 删掉，换成一个指向它自己的坏链接，整个依赖就没了（11-11 踩过）。要挑，先在 worktree 里 `git rm --cached node_modules` 补一个提交，再连它一起挑；挑的时候加 `-n`、事后再 `git reset -- node_modules` 来不及，目录在挑的那一下就删了。真删了：从另一个装好的 worktree 把 `node_modules` 搬回来（锁文件一样才行），不然重新 `npm ci`。
  2. `tooling/legacy-renderer/node_modules` 也要链（它是 npm workspace，装着 React 18 的类型）。漏了 `npm run typecheck` 会在 legacy 的 `src/components/ui/*` 报一串类型错，不是代码问题。
- **别用 `pkill -f <脚本名>` 收拾卡住的命令。** 命令行里带这串字的 shell 自己也会被杀掉。用进程号杀。（沿用 10-03）
- **`npm test` 和 `npm run test:v2` 可以在同一个目录里同时后台跑**，没冒过假红。（沿用 11-09）
- **容器里没有 zsh**（11-11 验），`electron/macos-platform.test.ts` 里真跑 zsh 的那批用例会自动跳过，不算失败。想让它们在容器里真跑，`apt-get install -y zsh`。（沿用 11-10）
- **容器里你是 root**（11-11 验）。Linux 版客户端拒绝以 root 启动，真开客户端要先处理这个（见第 7 节）。

## 4. Electron 二进制装不上时

11-11 `node scripts/ci-ensure-electron-binary.cjs` 一次成功。它以前在容器里经代理失败过（报 undici 的 `AssertionError: assert(!this.paused)`，重试也一样）。再碰到时，用 curl 把压缩包下到 Electron 的缓存里，再让安装脚本接着装（沿用 10-03，11-11 没重演）：

```bash
V=$(node -p "require('./node_modules/electron/package.json').version")
URL_DIR=https://github.com/electron/electron/releases/download/v$V
H=$(printf %s "$URL_DIR" | sha256sum | cut -d' ' -f1)
mkdir -p ~/.cache/electron/$H
curl -fL -o ~/.cache/electron/$H/electron-v$V-linux-x64.zip "$URL_DIR/electron-v$V-linux-x64.zip"
node node_modules/electron/install.js
```

缓存子目录名是「下载目录网址」的 sha256。安装脚本照常按包里的校验和核对后才解压，这条退路没有绕过校验。

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
- **作业日志用 GitHub 工具的 `get_job_logs` 加 `return_content: true` 看。** 它给的下载链接在容器里被代理拦。最多只回最后 5000 行，`macos-test` 这种更长的日志前半段取不到。（沿用 10-05、10-06）
- **只在 Windows 上跑的用例（`it.runIf(process.platform === 'win32')`）容器里跑不到。** 想确认它在 CI 上真跑了，看 Windows 作业日志里那个测试文件的那一行，形如 `✓ legacy electron/xxx.test.ts (9 tests | 2 skipped)`，拿跳过数对一下。（沿用 10-06）

## 7. 在容器里真开客户端走一遍

能做到：`npm run compile` 之后用 Playwright 起 Electron，外面套 `xvfb-run -a`（`xvfb-run` 容器里有，11-11 验）。账号站点一律用假接口，写法照 `e2e/realm-account-smoke.mjs`。

四个不处理就走不通的地方（沿用 10-26，11-11 没重演）：

1. 容器是 root，`linux-launch-guard` 拒绝启动。夹具里先 `process.geteuid = () => 1000` 再加载入口。只许在夹具里这么做。
2. 出网代理会换证书。要在夹具里对 `defaultSession` 和 `app.on('session-created')` 新建的会话都设 `setCertificateVerifyProc`，只放行代理那一个签发者；装工具用的是 `fromPartition` 出来的会话，只改默认会话不够。
3. 写密钥那一步走 `Session.prototype.fetch`，不经过换掉的 `net.request`，要把它也对账号站转给假接口。
4. 容器的 PATH 里自带一份 Claude Code（`/opt/node22/bin/claude`，11-11 验），客户端会当成「已装好但版本旧」。要走干净机器的路，给 `PATH=/usr/bin:/bin`。

另外，容器的环境变量里有一批 `ANTHROPIC_*`、`CLAUDE_*`（11-11 验）。在子进程里真跑某个 CLI 时用 `env -i` 起，否则这些变量会把它的请求带到真服务上。

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
