# 星芒精选扩展库（N6）

清单本身在 `bundled-catalog/curated-extensions.json`，这份文档说明它为什么存在、一条条目凭什么进来、以及谁在什么时候复核。

## 为什么需要它

外接工具、技能、插件三个页面的增删改早就做完了，但页面上没有任何推荐：空态只说「从页面上的添加入口开始」，用户得自己知道有哪些 MCP 值得装、包名叫什么、参数怎么填。
外面的生态已经起来了——Claude Code 的官方市场有上百个插件，Gemini CLI 也加了扩展管理——本产品的用户还站在空页面前面。

此前页面上有过三个「常用连接」按钮（浏览器、GitHub、本地文件），只做预填表单，**没有一句说明、没有风险提示、版本跟着 `@latest` 走**，其中「本地文件」还漏了必填的允许目录参数，点了其实装不起来。精选清单取代的就是它。

清单今天覆盖两页：**外接工具（MCP）** 五条，**插件（只给 Claude Code）** 五条。技能页仍然没有精选。

## 入选标准

一条条目要同时满足下面全部：

1. **官方维护**：由该协议或该服务自己的团队发布（Model Context Protocol 官方、微软、GitHub 官方这一类），不收社区镜像和个人重打包。
2. **不需要额外注册海外账号**就能用。唯一的例外是 GitHub，它保留在清单里但必须标 `requiresAccount`，界面上显示「需要先登录」。
3. **运行时本应用已经装好**：今天只收 Node 版。抓网页、时间、Git 这三件官方服务器只有 Python 版、要靠 `uv` 起，本应用没带 `uv`，所以先不收。
4. **版本可以钉死，钉不住就记下坐标**：npm 条目必须写成 `包名@确切版本`，`pinnedVersion` 与它一致。上游 MCP 服务器每周都在发版，`@latest` 意味着用户某天早上打开工具就换了一份新代码。
   插件是例外，见下面「插件为什么钉不住版本」——那里必须记下复核时的市场 commit。
5. **风险能一句话说清**，并且说得出口：`riskNote` 要写它到底能动什么、动坏了什么样。说不清的不收。
6. **不需要用户填密钥**。清单里永远不出现任何形式的凭据（测试里有断言）。

已经明确排除的：需要付费 Key 或海外账号的；已归档的官方服务器；第三方远程服务（Context7 一类，查询内容会出境）；`chrome-devtools-mcp`（官方自己声明可读取和修改浏览器里的任何数据）；只服务某一个 CLI 的专属扩展。

## 字段

| 字段 | 说明 |
|---|---|
| `id` | MCP 连接写进 CLI 配置时用的名字。ASCII，用户在工具里会看到它 |
| `kind` | `mcp` / `skill` / `plugin`。**`mcp` 与 `plugin` 各有五条，`skill` 还是空的**，技能页拿到空数组、精选卡整块不渲染 |
| `name` / `summary` | 面向用户的名字和一句「它能让 AI 多做什么」。大白话，不出现站点名与内部代号 |
| `publisher` / `homepage` | 谁维护、上游主页（必须 https） |
| `providers[]` | 哪些命令行工具能装。必须是 `electron/catalog.ts` 的 `providerIds` 的子集 |
| `install` | `{type:'stdio', command, args, env}`、`{type:'http', url}` 或 `{type:'plugin', marketplace, plugin}`。前两种就是会写进 CLI 配置的那份，第三种会拼成 `plugin install <插件名>@<市场名>`。确认框里都原样列出来 |
| `inputs[]` | 需要用户自己指定的东西（目录一类）。`install` 里以 `{{key}}` 占位 |
| `runtime` | `node` / `python` / `none` / `prompt`（`prompt` = 只给工具加命令和技能，不在用户电脑上跑额外程序） |
| `network` | `none` / `npm-first-run` / `always` / `install-only`，界面上翻成「第一次使用时需要联网下载」这类说法 |
| `requiresAccount` | 要不要登录对方的账号 |
| `risks[]` | `local-fs-write` / `browser` / `remote-exec` / `network` / `third-party` / `git-write` / `extra-usage`，每个在界面上有固定标签 |
| `riskNote` | 一句到几句中文，说清最坏能坏成什么样 |
| `pinnedVersion` | npm 条目的确切版本，与 `install.args` 里的那个必须一致；远程服务为 `null`；插件填它自己声明的版本，没声明就是 `null` |
| `marketplaceCommit` | 插件条目复核时市场仓库的完整 40 位 commit；MCP 条目为 `null`。写半截会被解析层整条丢掉（测试钉住） |
| `verifiedAt` | 上一次核对包名与版本的日期 |
| `note` | 补充说明，没有就写 `null` |

## 占位符

`install` 里的 `{{key}}` 必须在 `inputs` 里有同名一条，反过来也一样（测试钉住）。带占位符的条目**不会一键装上**：确认框上的按钮变成「继续填写」，点了之后把添加表单填好、并在表单顶上说清该把哪一项换成什么。提交时 `unresolvedInstallPlaceholders` 还会再拦一道——占位符没替换就写进配置，CLI 只会在下次启动时静默失败，用户根本不知道哪儿不对。

今天有两条用到它：
- **本地文件**：服务器不给目录就起不来（上游 README 明说，除非客户端支持 Roots）。
- **记忆**：不指定 `MEMORY_FILE_PATH` 时记忆文件落在 `npx` 缓存目录里，换一次版本就全丢了。

## 安装走哪条路

精选**不新开通道**。点「确认安装」之后走的还是页面上手填表单那一条出口（`submitMcpInstall`）：Codex 走它自己的 `mcp:add`，其余三家走 `mutateProviderExtension`。因此主进程 `provider-extensions.ts` 里的 `safeIdentifier`、argv 数组、`--` 分隔这一整套校验对精选同样生效，清单里就算写错也越不过那道门。

**Gemini 的 `--trust` 永远不会出现**，`--scope` / `--include-tools` 之类改变信任范围或工具白名单的开关也不许写进 `args`（测试钉住）。

插件同理：点「确认安装」走的是页面上「添加插件」那一条出口（`mutateProviderExtension`，`kind: 'plugin'`、`action: 'install'`、`source` 是 `<插件名>@<市场名>`）。主进程在执行前会自己保证官方市场在册（#277 的 `ensureClaudeOfficialMarketplace`，市场已在册时什么都不做），所以精选不需要知道市场是怎么注册的，也不需要自己去调那一步。`install.marketplace` 只能是 `curated-extensions.ts` 里 `curatedMarketplaceSources` 那张表上的名字——写一个别的市场名，条目会在解析时整条丢掉，因为应用本来也只会去注册官方那一个。插件名收窄到 `[a-z0-9-]`，开关、路径和第二个 `@` 都挤不进去。

## 插件精选（Claude Code，2026-09-21 复核）

只给 Claude Code。另外三家没有这个市场：Codex 的插件是它自己那一套，Gemini 与 Grok 根本没有插件页的市场接口，列出来就是列了装不上的东西。

### 插件为什么钉不住版本

`claude plugin install` **没有指定版本或 commit 的开关**（2.1.277 实测，`--help` 里只有 `--accept-command` / `--config` / `--registry` / `--scope` / `-y`）。装到的就是官方市场仓库当下那一份：插件自己声明了版本（manifest 里有 `version`）的，装完 `plugin list --json` 回的就是那个版本号；没声明的，回的是**市场仓库的短 commit**，本次复核时是 `c447c3207a42`。

所以清单里做两件事：
- `marketplaceCommit` 记下复核时市场仓库的完整 commit（本次 `c447c3207a425bc4e2a0d068435f64b0477ae981`，2026-09-18 的 `Partner metadata: Qodo description; Airwallex display name (#6257)`）。
- 确认框里那一行明写「安装的是官方市场当前的版本，我们复核过的是 c447c3207a42 那一版」，不假装钉住了。

这是**有意的取舍**，不是欠账：官方市场自己就没提供钉版本的办法，本应用要么照着它的形态收、要么整块不做。同样因为这个，插件的复核比 MCP 更要紧——上游改了什么，用户下次装就吃到了。

### 这五条凭什么进来

五条全部是 **Anthropic 自己在官方市场仓库里维护**的（`source` 是仓库内相对路径 `./plugins/<名字>`，不是第三方仓库的 `git-subdir`），**全部只由提示词、斜杠命令和子代理组成**——没有 hooks、没有 `.mcp.json`、没有要跑的脚本。这一条是硬门槛：

- **不引入本应用没带的运行时**。这一条直接排掉了装机量很高的 `security-guidance`（267k）：它的 hooks 是 `bash sg-python.sh <脚本>.py`，**要 Python 和 bash**，Windows 客户机上两样都不一定有，装上去只会在每次编辑后静默失败。
- **不悄悄改变工具的行为**。hooks 会在用户每次提交、每次编辑后自动跑，装一个插件顺带改掉工具的运行方式，超出「精选」该替用户做的决定。

| 插件 | 为什么值得装 | 风险标签 |
|---|---|---|
| `code-review` 代码审查 | 装机量最高的审查类插件（48 万），提交前分几个角度过一遍改动，按把握排序筛掉噪音 | `extra-usage` |
| `commit-commands` 提交与合并请求 | 国内开发者日常最高频的那几步（提交、推送、开 PR）合成一条命令 | `git-write` |
| `feature-dev` 功能开发流程 | 做稍大的功能时先读代码、再定方案、写完自查，比一上来就改稳 | `extra-usage` |
| `frontend-design` 前端界面 | 整个市场装机量第一（126 万），写界面时的取舍照能上线的标准来 | 无 |
| `claude-md-management` 项目说明维护 | 维护 `CLAUDE.md`，让工具记住项目约定——这件事本仓自己也在做 | `local-fs-write` |

明确排除的：
- **`security-guidance`**：要 Python + bash（见上）。
- **`playwright` / `github`**：它们只是把同名 MCP 服务器包一层，而这两件本来就在 MCP 精选里；两页各放一份只会让用户装两遍。
- **`context7` / `serena`**：第三方远程服务，查询内容出境——和 MCP 侧排除 Context7 的理由是同一条。
- **各语言的 `*-lsp`**：要用户自己先装好对应语言的语言服务器，属于「装了不一定能用」。
- **`hookify` / `ralph-loop` / 两个 output-style**：都带 hooks，改变工具本身的运行方式。

### 复核时怎么重新取一遍事实

沙箱里不用碰用户的 `~/.claude`：

```bash
mkdir -p /tmp/probe && cd /tmp/probe && npm install --no-save @anthropic-ai/claude-code@<名单里的版本>
export HOME=/tmp/probe/fakehome && mkdir -p $HOME
./node_modules/.bin/claude plugin marketplace add anthropics/claude-plugins-official
./node_modules/.bin/claude plugin list --available --json   # 每条带 name / description / source / installCount
git -C $HOME/.claude/plugins/marketplaces/claude-plugins-official rev-parse HEAD   # 这就是 marketplaceCommit
```

逐条看 `$HOME/.claude/plugins/marketplaces/claude-plugins-official/plugins/<名字>/` 下有没有 `hooks/`、`.mcp.json` 或脚本——有就不收，理由同上。

## 怎么复核

**每次发版前**，以及**上游出安全公告时**：

1. 逐条在 npm registry 上核对包名还在、没被 deprecated：
   `curl -s https://registry.npmjs.org/<包名> | node -e "..."`（看 `dist-tags.latest` 与 `deprecated`）。
2. 读上游 README / CHANGELOG，确认参数形态没变、没有新增必填项。
3. 决定要不要跟进新版本：跟进就同时改 `install.args` 里的版本和 `pinnedVersion`，并更新 `verifiedAt`。**不跟进也要更新 `verifiedAt`**，好让下一个人知道这条是核对过的、不是忘了。
   插件这边没有「跟不跟进」可选（装到的永远是市场当下那一份），要做的是按上面那段重新取一遍市场 commit 与插件构成：`marketplaceCommit` 更新成新的 HEAD，`verifiedAt` 跟着改；构成里长出了 `hooks/` 或 `.mcp.json` 就把条目删掉。
4. 上游换了维护者、仓库归档、或者风险描述不再准确 → 把条目从清单里删掉，而不是留着改文案。
5. 顶层的 `version` 在字段结构变化时 +1，`updatedAt` 每次改清单都更新。

## 还没做的

- 技能页的精选。官方分发形态各家都不一样（Codex 的导入只收本机绝对路径、Gemini 要 `--path`，而本仓的 mutate 只传 source），得先解决分发，不是加几条数据的事。
- 插件精选只覆盖 Claude Code。Codex 的插件市场是另一套形态，要单独评估。
- 抓网页、时间、Git 三条官方 Python 服务器，等本应用带上 `uv` 之后再评估。
