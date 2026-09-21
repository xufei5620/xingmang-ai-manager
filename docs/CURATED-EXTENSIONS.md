# 星芒精选扩展库（N6）

清单本身在 `bundled-catalog/curated-extensions.json`，这份文档说明它为什么存在、一条条目凭什么进来、以及谁在什么时候复核。

## 为什么需要它

外接工具、技能、插件三个页面的增删改早就做完了，但页面上没有任何推荐：空态只说「从页面上的添加入口开始」，用户得自己知道有哪些 MCP 值得装、包名叫什么、参数怎么填。
外面的生态已经起来了——Claude Code 的官方市场有上百个插件，Gemini CLI 也加了扩展管理——本产品的用户还站在空页面前面。

此前页面上有过三个「常用连接」按钮（浏览器、GitHub、本地文件），只做预填表单，**没有一句说明、没有风险提示、版本跟着 `@latest` 走**，其中「本地文件」还漏了必填的允许目录参数，点了其实装不起来。精选清单取代的就是它。

## 入选标准

一条条目要同时满足下面全部：

1. **官方维护**：由该协议或该服务自己的团队发布（Model Context Protocol 官方、微软、GitHub 官方这一类），不收社区镜像和个人重打包。
2. **不需要额外注册海外账号**就能用。唯一的例外是 GitHub，它保留在清单里但必须标 `requiresAccount`，界面上显示「需要先登录」。
3. **运行时本应用已经装好**：今天只收 Node 版。抓网页、时间、Git 这三件官方服务器只有 Python 版、要靠 `uv` 起，本应用没带 `uv`，所以先不收。
4. **版本可以钉死**：npm 条目必须写成 `包名@确切版本`，`pinnedVersion` 与它一致。上游 MCP 服务器每周都在发版，`@latest` 意味着用户某天早上打开工具就换了一份新代码。
5. **风险能一句话说清**，并且说得出口：`riskNote` 要写它到底能动什么、动坏了什么样。说不清的不收。
6. **不需要用户填密钥**。清单里永远不出现任何形式的凭据（测试里有断言）。

已经明确排除的：需要付费 Key 或海外账号的；已归档的官方服务器；第三方远程服务（Context7 一类，查询内容会出境）；`chrome-devtools-mcp`（官方自己声明可读取和修改浏览器里的任何数据）；只服务某一个 CLI 的专属扩展。

## 字段

| 字段 | 说明 |
|---|---|
| `id` | MCP 连接写进 CLI 配置时用的名字。ASCII，用户在工具里会看到它 |
| `kind` | `mcp` / `skill` / `plugin`。**今天只有 `mcp` 有条目**，技能与插件页拿到空数组，精选卡整块不渲染 |
| `name` / `summary` | 面向用户的名字和一句「它能让 AI 多做什么」。大白话，不出现站点名与内部代号 |
| `publisher` / `homepage` | 谁维护、上游主页（必须 https） |
| `providers[]` | 哪些命令行工具能装。必须是 `electron/catalog.ts` 的 `providerIds` 的子集 |
| `install` | `{type:'stdio', command, args, env}` 或 `{type:'http', url}`。就是会写进 CLI 配置的那份，确认框里原样列出来 |
| `inputs[]` | 需要用户自己指定的东西（目录一类）。`install` 里以 `{{key}}` 占位 |
| `runtime` | `node` / `python` / `none` |
| `network` | `none` / `npm-first-run` / `always`，界面上翻成「第一次使用时需要联网下载」这类说法 |
| `requiresAccount` | 要不要登录对方的账号 |
| `risks[]` | `local-fs-write` / `browser` / `remote-exec` / `network` / `third-party`，每个在界面上有固定标签 |
| `riskNote` | 一句到几句中文，说清最坏能坏成什么样 |
| `pinnedVersion` | npm 条目的确切版本，与 `install.args` 里的那个必须一致；远程服务为 `null` |
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

## 怎么复核

**每次发版前**，以及**上游出安全公告时**：

1. 逐条在 npm registry 上核对包名还在、没被 deprecated：
   `curl -s https://registry.npmjs.org/<包名> | node -e "..."`（看 `dist-tags.latest` 与 `deprecated`）。
2. 读上游 README / CHANGELOG，确认参数形态没变、没有新增必填项。
3. 决定要不要跟进新版本：跟进就同时改 `install.args` 里的版本和 `pinnedVersion`，并更新 `verifiedAt`。**不跟进也要更新 `verifiedAt`**，好让下一个人知道这条是核对过的、不是忘了。
4. 上游换了维护者、仓库归档、或者风险描述不再准确 → 把条目从清单里删掉，而不是留着改文案。
5. 顶层的 `version` 在字段结构变化时 +1，`updatedAt` 每次改清单都更新。

## 还没做的

- 技能页与插件页的精选。技能的官方分发形态各家都不一样（Claude 走插件市场、Codex 的导入只收本机绝对路径、Gemini 要 `--path`），得先解决分发，不是加几条数据的事。
- 抓网页、时间、Git 三条官方 Python 服务器，等本应用带上 `uv` 之后再评估。
