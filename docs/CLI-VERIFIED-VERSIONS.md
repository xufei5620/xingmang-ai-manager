# CLI 已验证版本名单（N1）

名单本身在 `electron/cli-verified-versions.ts`，这份文档说明它为什么存在、怎么维护。

## 为什么需要它

本产品把四个 CLI 的 base URL 全部指向自家中转，而这些 CLI 每周都在发版，**针对第三方 base URL 的回归是反复出现的，不是偶发**。
Claude Code 官方 changelog 里就有两条直接命中本产品形态的：

| 版本 | changelog 原文要点 |
|---|---|
| 2.1.268 | 修复「第三方 Anthropic 兼容端点（`ANTHROPIC_BASE_URL`）上每次请求都返回 400」，**自 2.1.265 起** |
| 2.1.277 | 修复「`ANTHROPIC_BASE_URL` 指向代理或网关时每次请求因 `400 … Input tag 'advisor_20260301'` 失败」，**2.1.275 引入的回归** |

也就是说确实存在这样的版本窗口：用户把 CLI 更到最新，整条链路全线不可用。
在客户那里它的表现是「星芒坏了，我要退款」，而客服既看不出对方在用哪个 CLI 版本，也没有手段让他退回去。

## 名单管什么

每个 provider 一条 `recommended`（推荐安装的确切版本）和一组 `blocked`（已知不兼容的版本区间 + 一句中文原因）。

- **安装与更新默认装 `recommended`**，而不是 npm latest。`recommended` 为 `null` 的 provider 继续装 latest，行为与从前完全一致。
- **已装版本落在 `blocked` 区间时**，首页那一行显示「不兼容，建议回到 x.y.z」并给出「回到推荐版本」按钮。
- 用户可以在「设置 → 更新」里打开**「命令行工具总是装最新版」**跟随官方最新版；默认关闭。打开后不再显示「推荐 x.y.z」，但**不兼容提示与回滚入口仍然保留**——那是安全网，不是建议。
- 名单把安装钉在已装的那个版本上时，工具行不会再显示「有更新」：点了也只是把同一个版本重装一遍。`latestVersion` 仍照实记录 npm 上的最新版，不瞒着上游进度。

`blocked` 区间是左闭右开的 `[introduced, fixed)`；`fixed: null` 表示上游还没修，区间一直开着。

## 站点维度

`VerifiedCliRelease.verifiedSites` 与 `BlockedCliVersionRange.sites` 记录条目对应哪些中转站点（`relay-sites.ts` 的 `RelaySite.id`）。
`sites` 缺省 = 所有站点，这是常态：上游回归打的是「第三方 base URL」这一整类，与站点无关。

**双站点是有意做成用户无感的，所以站点信息只存在于数据与文档里，永远不出现在界面文案上。** 用户只看到「推荐版本」。

## 怎么更新名单

1. 读上游 changelog（Claude Code 是 `https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md`），找与 `ANTHROPIC_BASE_URL` / 第三方端点 / 网关相关的修复与回归。
2. 有新的回归窗口 → 往 `blocked` 里加一条，`introduced` 写 changelog 明说的引入版本，`fixed` 写修复版本，`reason` 用一句用户读得懂的中文。
3. 实测新版本可用 → 更新 `recommended`：`version` 填确切版本号，`verifiedAt` 填验证日期，`verifiedSites` 填实测过的站点 id（没实测就留空数组并在 `note` 里说明依据）。
4. `npm test` 会验证：名单覆盖全部 provider、版本号是精确 semver、**推荐版本不落在自己的 `blocked` 区间里**、每条推荐都有验证日期和中文备注。

首版只维护 Claude Code——它是这批客户最想要的那个，也是回归最频繁的那个。加第二个工具只需要填上它的 `recommended`，其余代码不用动。

## 谁来跑：每周巡检

名单越旧，默认装的版本离上游越远；而没人盯着的话，它只会在客户报障那天才被想起来。所以有一条每周的巡检例程（Routine）替人盯着：

- **名字**：`Claude Code 新版每周巡检`
- **频率**：每周一 01:00 UTC（北京时间周一 09:00）
- **它做什么**：取 npm 上 `@anthropic-ai/claude-code` 的 `latest`，和名单里的推荐版本比。一样就只回一句「本周无新版」；不一样就把这两个版本之间的上游 changelog 逐条读一遍，摘出与网关 / 代理 / 第三方 base URL / 鉴权 / 400 相关的行。没有回归就开一个**草稿 PR** 抬推荐版本（含文档与 `changes/unreleased/` 分片）；有回归就改为把新版加进 `blocked` 并写清原因。
- **它不做什么**：不自己合并。抬版本的 PR 一律留给人复核——中转实测没跑过、或者跑红了，都不许合。

npm 上的 `stable` 这个 dist-tag **不能用作判断依据**：它曾经指向 `2.1.267`，而那个版本正落在名单里 2.1.265–2.1.268 那条不兼容区间内。只看 `latest`。

## 谁来验：CI 里的中转实测

「这个版本在我们的中转上能用」这句话，过去只有上游 changelog 作背书。但名单挡住的两次回归都是 **CLI 自己发出的请求**被第三方端点拒掉——用 `curl` 手搓一个请求验证不了，出问题的正是 CLI 构造请求的那一段。

所以 quality 工作流里有一个 `cli-relay-probe` 作业（`scripts/probe-cli-relay.cjs`）：

- **什么时候跑**：PR 改到 `electron/cli-verified-versions.ts` 或本文档时。别的 PR 改不动这个答案，不值得对生产中转发真实请求。
- **跑什么**：装上名单钉住的那个版本，对 `relay-sites.ts` 里的**每个**中转站点各跑一次 `claude -p` 最小请求，结论写进 job summary。
- **密钥**：仓库 secret `XINGMANG_CLI_PATROL_KEY`，一把额度很小的测试 Key。它只通过子进程环境变量交给 CLI，不进 argv，作业打印和写进 summary 的每一行都先过一遍脱敏。
- **没有配密钥时**：作业照常通过，但 summary 里明确写「未在中转实测」。一句诚实的「没验证」比一个看着绿的空作业有用。
- **结论怎么读**：只有「端点拒绝了 CLI 发出的请求（400 类）」才说明这个版本不能推给客户。401/403、额度不足、5xx 是**探测本身坏了**，作业同样变红，但那是去修密钥或等中转恢复，不是去改名单。

跑通之后，把跑通的站点 id 写进那条 `recommended` 的 `verifiedSites`。

## 不要做的事

- 不要把 `recommended` 写成 `latest`、`^2.1.0` 这类范围或 dist-tag。IPC 侧只接受精确 semver（`ipc.ts` 的 `parseCliInstallVersion`），范围表达式会让 npm 自己去决定装什么，等于绕过名单。
- 不要为了「让用户拿到新功能」把过期的 `recommended` 留着不动——名单越旧，默认装的版本离上游越远。上游发了新版就跑一次验证。
