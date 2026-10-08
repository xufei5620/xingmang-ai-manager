# xm 三线路·客户端需求（0.2.18 起）

> 10-08 起草、10-09 定稿，服务端整理。本文是 xm「洛杉矶 / 香港 / CF」三线路的**客户端部分**，接在《直连线路补充需求》（`docs/DIRECT-ROUTE-RELAY-SUPPLEMENT.md`，#941）之后。服务端怎么做不在本文范围，这里只写客户端要依赖的接口和行为。
>
> - **#941 第 6 节「同一线路多个候选域名」作废**，改用本文的 L2（独立线路 `direct-hk`），那一节不要再做。
> - **只改 `solov` 站点**（xm.solov.cc，new-api）。`solov-api`（sub2api）的线路逻辑、界面文案和现有测试一行不动。
> - 代码位置写成「文件:行号（符号名）」，以 origin/main `8c3badb7`（0.2.17，#942、#943 已合）为准；行号漂了按符号名 grep。**不要在 #941 分支上核对代码**：它基于 10-07 的标签版，没有 #942、#943。
> - `App.tsx` 指 `src/renderer-v2/App.tsx`；`account-bootstrap.ts`、`source-marker.ts`、`Home.tsx` 都在 `src/renderer-v2/features/tools/` 下。界面只改 renderer-v2，legacy 树已冻结（AGENTS.md T14）。
> - 本仓库公开：提交、PR、测试固件、日志样例里不出现用户信息、星芒服务器的 IP 和服务器内部信息。测试用的地址、灰度名单由我们私下提供，**不要提交进仓库**。
> - 【待实测】= 还没在真机核实；【待定】= 等我们给结论，本期不做。

## 0. 先看这几条

1. **目标**：管理工具在用户本机替他挑一条通的线路，只把**域名**写进各 AI 工具的配置文件；管理工具关着时，各工具照常可用。
2. **本期只做第一批（4.1 节），合起来发 0.2.18。** 第二批（4.3 节）等我们给结论，先别做。
3. **版本号必须是 0.2.18。** 线上已经有两个都叫 0.2.17 的包：10-07 的标签版 `8c56f021` 和 10-08 的 main `8c3badb7`。客服靠版本号判断用户装的是哪套逻辑，以后不许再用同一个版本号重新打包。
4. **动手前先回一份拆 PR 的计划**（4.1 节有建议拆法，可以调整），我们确认后再写代码。

---

## 1. 硬约束与不做什么

本节是全文的约束，后面不再重复，只引用编号。

### 1.1 硬约束

| # | 约束 | 对客户端意味着什么 |
|---|---|---|
| ① | 不能要求管理工具一直开着 | 写进工具的只能是静态配置（各工具自己的配置文件），工具不能依赖管理工具在运行。管理工具关着期间处理不了单个用户的线路问题，下次打开时再处理；洛杉矶整体故障由服务端改 DNS 兜底 |
| ② | 不能影响用户自身网络 | 不设系统代理、TUN、DNS、hosts、环境变量；线路选择不能作用到用户自己的其它网络流量 |
| ③ | 每个用户在自己这边切线路 | 客户端只按本机的探测结果给本机换线，不能因为一个人的问题让所有人切。整体故障由服务端判断；服务端正在处理整体故障时，客户端**不跟着改配置**（5.1.5 节 incident） |

### 1.2 不做什么

- **不做本机转发**：不起本地端口，不往任何配置里写回环地址或代理地址。
- **不改系统**：不设系统代理、TUN、DNS、hosts、用户级或系统级环境变量。**读**这些设置、用来决定测哪条路径，可以。
- **配置里只写域名**。代码和测试固件里不新增星芒自己的服务器 IP（主服务器、中转、旧入口），服务端换入口只改 DNS。
  - 公开网段可以写进代码：Cloudflare 公布的 IP 段、RFC 规定的特殊用途段。测试固件里的 IP 用 RFC 5737 / RFC 3849 的文档地址。
  - `relay-sites.ts:176-179` 里 `direct` 已经带一个退役测试入口的别名（IP:端口 形式）。本期原样保留，只用来认出按它写过的旧配置和旧标记（`account-bootstrap.ts:222-223`、`source-marker.ts:49-52`）。**永远不写入**，也不新增别的。
- **管理工具自己的流量不走香港**：账号、余额、公告、AI 工作区（聊天、生图、视频）、更新、读线路状态文件，都只走应用线路（L1/L3）。例外有两个：
  - 工具线路对香港的健康探测；
  - 工具自检。它测的就是工具配置里实际写的地址，见 5.1.0。
- **不用 DoH**，也不去改 Electron 的安全 DNS 设置。DoH 在部分移动网络下本身不通，还会把查询的域名交给第三方。
- **证书校验必须同时信任系统根证书**。否则开着 HTTPS 扫描的安全软件、装了公司根证书的用户，会被误判成线路坏了。
- **不提供「只用香港」选项。**
- 本期不改「从管理工具打开 Codex 桌面端时自动连加速」（C14，待定），也不做任何上报（C21，待定）。

---

## 2. 线路定义

### 2.1 三条线路

| 代号 | 域名 | 背后是什么 | 角色 | 代码里的线路 id |
|---|---|---|---|---|
| **L1 洛杉矶** | `xm-direct.solov.cc`（沿用，不改名） | 洛杉矶中转，按 SNI 原样转发到主服务器（不解密，证书不变）。10-08 已切换 | 主线路，所有用户默认 | `direct` |
| **L2 香港** | **域名未定**（可能不在 solov.cc 下） | 香港中转，同上 | 备用，容量有限。只写进 AI 工具配置，而且只在 L1 对这个用户不通时才写 | `direct-hk`（第二批才加） |
| **L3 CF** | `xm.solov.cc` | Cloudflare | 兜底 | `primary` |

- **旧直连入口**：没有独立域名，服务端用它承接还缓存着旧解析结果的 DNS。客户端不主动写入，也不需要认识它。
- **服务端自动切换**（下称「服务端切换」，**还没上线**）：
  - 洛杉矶整体故障时，服务端把 `xm-direct.solov.cc` 改指向香港或 CF。
  - 香港容量紧张时，服务端把香港域名改指 CF。**不指回洛杉矶**，因为停在 L2 的用户正是洛杉矶对他不通的人。
  - 客户端配置不用改，但域名的解析结果会变，所以合法 IP 集合要从状态文件读（第 7 节）。
- 已写进用户配置的域名都是永久承诺：服务端以后只改指向，不删记录。

### 2.2 两套线路

| | 应用线路 | 工具线路 |
|---|---|---|
| 给谁用 | 管理工具自己的请求 | 写进各 AI 工具的配置：Codex、Claude Code、Gemini、Grok、生图技能 config.json、Claude Desktop、WorkBuddy、OpenCode |
| 候选 | L1、L3 | L1、L2、L3（L2 第二批才生效） |
| 探测 | 沿用现在的 Chromium 探测和防抖（`main.ts:1131`，`probeRelayLineHealth`） | 新的「工具同路径」探测（C4），模拟 AI 工具自己的网络路径 |
| 适用站点 | `solov` 与 `solov-api`（`solov-api` 行为不变） | 只有 `solov` |

两套线路可以不一样。例如 Chromium 探测 L1 通、Node 探测 L1 不通时，管理工具自己走 L1，工具配置写 L3。

### 2.3 用户偏好（只对 solov）

- `solov` 的选项改为：**自动（推荐）/ 只用洛杉矶 / 只用 CF**。
  - 存储值不变（`auto` / `direct` / `primary`），只改显示名，老设置文件照常读。
  - 「只用洛杉矶」「只用 CF」时，两套线路都固定在那一条，不探测、不切换。
- `solov-api` 照旧显示「自动（推荐）/ 只用直连 / 只用默认线路」。
  - 现在两个站共用一份选项表：`connectionRouteChoices`（`src/renderer-v2/registry/connection-routes.ts:15-19`），由 `connectionRouteOptions` 使用（`:21-25`）。要改成按站点取。
  - `solov-api` 的说明（`:7`）现在写的是「用法和上面一样」。上面那条改了以后这句就不对了，要改成它自己完整的一句，意思不变。
  - 加单测，确保 `solov-api` 的选项名不变。

---

## 3. 现状：main 仍有的缺口

#942 已经修了这几处：

- 去掉运行状态检查（`account-bootstrap.ts:441-464`）；
- 星芒账号开机直接定在直连（`relay-route-controller.ts:64-67`，`unconcludedStart`）；
- 公告不再上报线路失败（`relay-line-fetch.ts:76`，`unreportedPaths`）；
- 失败判定加了 3 次防抖；
- 余额刷新改为前台 60 秒、后台 10 分钟（`balance-store.ts:38-39`）。

还剩六个缺口：

| | 缺口 | 位置 | 对应改动 | 批次 |
|---|---|---|---|---|
| (a) | 来源记录不是 account 的配置，永远不迁移。而首页只要地址属于本站任一条线路，就显示「已连接」，用户看不出 Codex 其实在 CF | 渲染层：`account-bootstrap.ts:207-224`（`accountRouteMigrationNeeded`）、`:293-331`（`accountBootstrapPlan` 的 skipped 分支）。主进程：`system-service.ts:7186`（`saveConfig` 的来源闸门）。首页的判断：`relay-sites.ts:266-276`（`relayProviderBaseUrlMatches`）、`config-files.ts:1732`（`matchesRelay`） | 首页如实显示：C12（第一批）。放宽迁移范围：C8（第二批，待定） | 拆开 |
| (b) | Claude Desktop、WorkBuddy、OpenCode 开着时不改，之后只在下一次扫描（启动、重新检测、换线、保存配置后）时重试，没有定时器 | `system-service.ts:6620-6623`（`followExternalClientRoute` 的 `status.running` 分支） | C11 | 第一批 |
| (c) | #942 去掉了延后，但注释里承诺的「由渲染层提示客户重开」没有做 | `system-service.ts:7195-7196`（`saveConfig` 里 `followedRoute` 上方的注释） | C10 | 第一批 |
| (d) | 停在 CF 以后，要连续运行约 10 分钟才迁回直连，这时管理工具多半早关了 | `relay-route-controller.ts:329-339`（`checkRecovery`） | C3 回升规则 | 第一批 |
| (e) | 跟线走的是完整开机流程：同步 Key（`account-cli-provisioner.ts:276-360`），在目标线路上查两次模型列表（provisioner 一次，`system-service.ts:7213` 一次），再整份 merge 写入。任何一步失败，工具就停在旧线路，只等下一次换线、启动或网络恢复才重试 | `App.tsx:672-684`（`followRelayRoute` → `runAccountBootstrap`） | C9 定点改写 + 定时重试 | 第一批 |
| (f) | `settledRouteLine` 要求保存的偏好等于当前生效的偏好。用户改了线路设置、还没重启时，什么都不迁 | `account-bootstrap.ts:198-204`（`settledRouteLine`） | 5.3.6 节 | 第一批 |

注意 (a)：C8 拍板之前，来源不是 account 的那部分用户在 0.2.18 里**仍然不会被自动迁移**，首页会如实显示他们在 CF。这是有意的，不要当 bug 顺手修。

---

## 4. 分期

### 4.1 第一批：现在就做，合起来发 0.2.18

第一批只包含**不依赖任何待定项**的改动。建议拆成三个功能 PR 加一个定版 PR。拆法可以调整，在计划里说明理由。

| PR | 内容 | 改动编号 | 说明 |
|---|---|---|---|
| **PR-1 工具配置跟线修复** | 定点改写、重记来源、回读核对、迁移前原件、失败定时重试；偏好不一致 (f)；外部客户端定时重试；重开提示（含 Gemini 窗口）；首页逐工具显示实际线路；`route.followed` 补字段 | C9、(f)、C11、C10、C19、C12、C17 的 `route.followed` 部分（5.3.5） | 修的是现有 bug，单独合进去就有价值。触发源先用现有的单一线路变化，PR-2 再换成工具线路 |
| **PR-2 两套线路与工具同路径探测** | 工具线路控制器（solov 专用）；工具同路径探测；失败归类与劫持提示；读线路状态文件；incident 等待；退避回升；按 IP 去重；三线全挂提示；管理工具自己的请求只跟应用线路；`relay.route.*` 日志；L2 骨架（不生效） | C3、C4、C5、C6、C7、C20、C17 的 `relay.route.*` 部分（5.1.9） | 核心状态机，单测量最大 |
| **PR-3 文案、诊断与更新源** | 三线路文案（只改 solov）、诊断补充；xm-direct 落到香港时，更新改用包里的源（可选） | C16、C15 | C15 做不完可以放 0.2.19 |
| **定版 PR** | 0.2.18 定版，汇总 changes 分片 | C1 | 照 #939 / #943 的做法单独开一个 PR。发版和放量我们来 |

**L2 骨架的规则。** 状态机按「有序候选线路表」写，L2 可以先留位置。香港 origin 给出之前：

- 代码里不能出现任何可被选中的香港地址。不要先猜一个域名写上。
- `direct-hk` 不能写盘（设置、`relay-route-lines.json`、工具线路状态文件），也不能成为设置或 IPC 能接受的值。
- 整条 L2 路径不生效，工具线路实际只在 L1/L3 之间选。这不阻塞 0.2.18。
- 识别「星芒地址」的代码不要写死成 `*.solov.cc`（香港域名可能不在 solov.cc 下），以现有的精确 origin 表为准。

### 4.2 第一批里已经定了的事

- **C19：保留 Gemini 启动注入**（`system-service.ts:5927-5934`，`launchProviderOperation`）。它能挡住项目 `.env` 和不信任目录带来的问题。只改提示：从管理工具打开的 Gemini 窗口，在提示规则里算「运行中」，提示「关掉这个窗口再打开」。
- **重开提示只在因故障切换时出现**（C10）。代码注释里记着「线路的事不要太多提示」（见 `App.tsx` 的 `followRelayRoute` 和 `account-bootstrap.ts` 里的注释），两者不冲突：
  - 回升、计划内迁移、开机跟线照旧一声不吭；
  - 只有因为故障换了线、而且这个工具确实要重开才生效时才提示，并且限频。

### 4.3 第二批：等我们给结论再做

| 项 | 内容 | 在等什么 | 先别动什么 |
|---|---|---|---|
| **C8 放宽迁移范围** | 三条同时成立时只改 base_url，不碰 Key：① 来源 unknown（含 v1 旧记录）；② 原地址是本站某条线路的 origin；③ 文件里的 Key 与当前账号某把 Key 的哈希一致。另外，`manual` / `changed` 的配置在首页给「一键改到当前线路」按钮 | 我们拍板。这一项是在放宽「来源未经确认就不自动改写」的同意规则 | 两道闸原样保留：渲染层 `account-bootstrap.ts:293-331`、主进程 `system-service.ts:7186`。第一批的定点改写只作用于来源是 account 的配置 |
| **C14 Codex 桌面端自动加速** | 三选一：去掉 / 每次打开前征得同意 / 只对 ChatGPT 登录用户保留并征得同意 | 我们拍板 | `codex-desktop-service.ts:3546-3550`（`connectAccelerationBeforeLaunch`）、`:3582`、`:3610`，`main.ts:1327-1346`，以及 `codex-desktop-acceleration.ts`：**现有行为原样保留，不要顺手改**。可以先写「强杀管理工具后系统代理能否还原」的测试步骤（V10），只测不改 |
| **香港接入** | C2：给 solov 加 `direct-hk` 线路和 origin（`relay-sites.ts:15` `RelayEndpointId`、`:172-187` `siteEndpoints`）。<br>C13：生图 MCP 白名单（`bundled-skills/xingmang-ai/scripts/mcp-server.mjs:28-32`，`ALLOWED_RELAY_ORIGINS`）加上香港 origin。写 L2 之前，先确认本机**已安装**的技能脚本包含香港 origin，否则技能的 baseUrl 留在 L1/L3。<br>写配置前查模型列表改走应用线路（5.1.0）。<br>逐一核对写死地址的地方（5.9 节）。<br>更新源对香港的处理（C15 补充） | 香港域名：等服务端做完换注册域名后的连通性实验，由我们拍板。另外还要等状态文件上线 | **C2 和 C13 必须同一版发。** 先别写任何香港域名 |
| **C21 匿名汇总上报** | 经 L3 上报线路健康计数（只报线路 id、失败类别、时间窗），供服务端判断国内一侧的整体故障 | 隐私口径拍板，以及服务端的接收接口 | 不加任何上报 |
| **C22 按账号的香港资格** | 从带鉴权的接口读「本账号能否用 L2」 | 是否做、接口放在哪 | 不改账号接口 |

**香港开启的前提落在「认识香港域名的那一版」上，不是 0.2.18。**

- 0.2.18 发出时香港域名还没定，它不认识香港地址。
- 不认识香港地址的版本，会把工具配置里的香港地址当成来源未确认的配置，永远不迁；旧的 MCP 白名单也会拒绝它。
- 服务端会等认识香港域名的版本占到活跃客户端的 90% 以上，再开香港。

---

## 5. 改动明细

> 每项按「位置 → 要做什么 → 验收点」写。行为规则是我们已经定的；改动面和实现方式你可以提更好的办法，在计划里说明。

### 5.1 工具线路状态机（C3、C4、C5、C6、C20，PR-2）

#### 5.1.0 结构与线路归属

- **现有控制器原样保留，作为「应用线路」**（`electron/relay-route-controller.ts`，`createRelayRouteController`）。`solov` 和 `solov-api` 都继续用它。`solov-api` 的行为零变化，现有测试里 `solov-api` 的用例必须原样通过。
- **另起一个只管 `solov` 的「工具线路」控制器**，加上新的探测模块 `electron/tool-path-probe.ts`（C4）和状态文件读取模块（C5）。
- **开机初值**：先用上次存下的工具线路；没有存档时（升级后第一次运行）见 5.1.8。对 `solov` 来说，工具线路始终是「定下来的」，不再有未定状态。`providerRelaySite`（`system-service.ts:3053-3057`）里「未定时保留原地址」的分支对 `solov` 不再适用，`solov-api` 照旧。
- **渲染层**要知道工具线路（首页、提示）：
  - 在设置快照里加一个新字段，例如 `relayToolRouteLines`（`system-service.ts:7603-7607`）。**不要复用** `relayRouteLines` 的含义。
  - 新字段是只读的运行时快照，和 `relayRouteLines` 一样：不落盘，`settings:save` 时忽略它。
  - **不要**像 `activeRelayEndpointIds` 那样核对回显（`ipc.ts:2931-2943`）。工具线路在运行中会变，冻结的 legacy 渲染层会把整份设置原样回传，带着旧值也不能让保存报错。
- **加 IPC 通道**要三处一致（AGENTS.md T1：`ipc-contract.ts` / `ipc.ts` / `preload.ts`，不看先后顺序），计划里写清要加几个。

**线路归属。** 把现在所有读 `relayRouting` / `activeRelaySite()` / `relayRouteController.route()` / `settings.relayRouteLines` 的地方全部列出来，逐个标出归属，写进计划。已知的有下面这些。其中几处不读这几个名字，grep 不到，要特别注意。

| 位置 | 归属 | 说明 |
|---|---|---|
| `providerRelaySite`（`system-service.ts:3053-3057`）；`saveConfig` 的 `activeSite`（`:7193`） | 工具线路 | 写地址用它。写前查模型（`:7213`）照旧用同一个 `activeSite`：查的正是工具将要用的那条线路（`system-service.ts:2601-2605`、`relay-line-fetch.ts:281-284` 的注释），第一批的工具线路只可能是 L1/L3，不涉及香港 |
| `inspectNativeProviderConfig`（`system-service.ts:3060-3065`）→ `AppConfigSummary.providers[*].baseUrl` | 工具线路 | 这是配置摘要里的「期望地址」。渲染层用它判断要不要迁（`account-bootstrap.ts:219-220`）、迁没迁成（`:484-485`）。只改 `providerRelaySite` 不改这里，两套线路不一致时会悄悄判成「不用迁」，或者误报「服务地址尚未与当前账号匹配」 |
| `followExternalClientRoutes` 的 `to`（`system-service.ts:6555`）；`followExternalClientRoute` 的写入地址（`:6590-6594`）和换线前查模型（`:6628`） | 工具线路 | 同第一行 |
| 外部客户端的对账与写入：`externalClientContext`（`system-service.ts:6346-6352`）、`configureExternalTool`（`:6491`） | 工具线路 | 检测、自检、保存后复测读的是同一份期望地址 |
| `system-service.ts` 里其余的 `activeRelaySite()`：`:6246`（`fetchAvailableModels` 没传站点时的缺省值）、`:7287`（只用站点 id） | 逐个核对 | 缺省值要看调用方是谁 |
| 检查页与工具自检：`codexProbeContext`（`main.ts:1481-1487`）、`checkConnection`（`main.ts:1575-1580`）里用来对账的期望地址 | 工具线路 | 自检用的 `createRelayObservedFetch` 语义不改，见 5.2 |
| 生图技能的 baseUrl：`ipc.ts:3515-3517`（取自 `getConfig().providers.codex.baseUrl`） | 工具线路 | 跟着上面 `inspectNativeProviderConfig` 那一行走 |
| 渲染层的 `settledRouteLine`（`account-bootstrap.ts:202`，读 `settings.relayRouteLines`） | 工具线路 | 改读新字段；主要逻辑挪到 5.3 |
| `createRelayLineFetch`（账号、余额、公告、AI 工作区） | 应用线路 | 5.2 |
| 代理分流的站点探测（`main.ts:1184`、`:1188`） | 应用线路 | 给管理工具自己的请求判断走不走代理 |
| 更新源（`main.ts:1645-1650` `useUpdateFeedLine`、`:1837-1847`） | 应用线路 | C15 |
| 反馈里「这次用的线路」（`feedback-environment.ts:268-275`，`resolveFeedbackRelayRoute`）、诊断「星芒 AI 网络」一项（`main.ts:1464-1477`，`diagnosticsRelayRoute`） | 应用线路 | 另加工具线路的几行，见 C16 |
| `main.ts:1327-1346` 加速判断里读 Codex 配置那一处 | 与线路无关，**不改** | `codexDesktopNeedsAccelerationOnlyAtStartup` 只看 `matchesRelay`（`codex-desktop-acceleration.ts:129-133`），它认本站所有线路。加一条单测：工具线路 ≠ 应用线路时，`onlyNeededAtStartup` 的结果不变 |

另外加单测：工具线路 ≠ 应用线路时，迁移照常进行。

#### 5.1.1 探测（C4，新增 `electron/tool-path-probe.ts`，在 Node 主进程里做）

**无代理路径**（Claude Code CLI、Gemini、Grok 的默认路径，永远要测）：

1. `dns.lookup(host, { all: true })`，走系统解析。
2. 按系统给出的地址顺序，逐个 `tls.connect({ host: ip, servername: host })`。
   - **任一地址握手成功就算通**（Happy Eyeballs 语义，不要求全通，IPv6 不通不能把线路判死）。
   - 每个地址的结果另记入诊断。
3. 证书校验同时信任系统根证书：
   - 优先用 `tls.getCACertificates('system')`。Electron 43 内置的 Node 有没有这个 API【待实测】，在主进程里调一次就知道，结果写进计划。
   - 没有的话，退路是同一主机上的对照：Node 只用自带根证书时报**证书错误**，而 Chromium 探测（它用系统根证书）校验通过，就判为「安全软件接管」。**不要为探测起子进程**：`certificate-trust-probe.ts` 的两次握手是让用户本机的 Node 子进程跑的（`:56-66`、`:79-90`），只能握手，做不了第 4 步。
   - 只用自带根证书失败、加上系统根证书才通过的，**算通过**，标为「安全软件接管」。
4. 在这条 TLS 连接上发 HTTP/1.1 `GET /api/status`，必须返回 200，且正文 JSON 里 `success: true`。重定向一律算失败，不跟。
5. 写法参照 `ai-asset-store.ts:391-436`（`defaultPinnedAiAssetFetch`：`https.request` + 固定 `lookup` + `agent: false`）。照 I10：超时、正文上限、不跟重定向、只允许本站线路的 origin。

**代理路径**（检测到代理时才加测；只读，不改任何设置）：

- **系统代理**：
  - 读 Windows 注册表或 macOS scutil。也可以用 `session.resolveProxy` 判断代理对这个 origin 是否生效（能覆盖 PAC 和绕过列表）。
  - 生效的话，用现成的 `systemProxyFetch`（`main.ts:1169-1175`）测。经代理时 Chromium 走 CONNECT 隧道里的 TCP TLS，不用 HTTP/3。这条路径代表 Codex 和 Claude Desktop。
- **`HTTPS_PROXY` / `ALL_PROXY`**：
  - 进程环境和用户级、系统级环境都要读（Windows 是 `HKCU\Environment` 和系统环境）。用户新开的终端读的是后两者，管理工具进程继承来的可能是旧值。
  - 另建一个内存分区，用 `session.setProxy({ proxyRules })` 测。
- Linux 本期只测无代理路径。

**判定：**

- 一条线路要在**所有在用的路径**上都通，才算「通」。没有一条线路能在所有路径上都通时，以无代理路径为准。
- 每条路径的超时不少于 10 秒（与 `relay-route-controller.ts:69-71` 一致）。
- **失败计数只算连接级失败**：连接被重置、完全没有字节返回的超时、证书错误、DNS 失败。「慢但有进展」（已收到响应头，或正文在持续到达）不算失败。

`main.ts:1131` 的 Chromium 探测保留，继续给应用线路和 `solov-api` 用。诊断页把两种探测的结果并列显示。

#### 5.1.2 失败归类（C6，可以并入 C4）

**通不通只看端到端结果**（TLS 校验通过 + `/api/status` 正常）。IP 集合只用来给失败打标签，不单独判失败。否则会出两个问题：

- L3 解析出的是 CF 的 IP，会被永远判失败，兜底失效；
- 用 Clash / Surge fake-ip 或 TUN 的用户会被误判为劫持。

| 解析结果 | 标签 | 处理 |
|---|---|---|
| 在该线路的合法集合里。L1/L2 用状态文件里的 `lines.<id>.legit_ips`；L3，或 `proxied: true` 的线路，用 Cloudflare 公布的 IP 段 | 正常 | — |
| 落在 RFC 2544 基准测试段（Clash / Surge fake-ip 默认用这一段）、RFC 1918 私网、RFC 6598 共享地址、回环，或 IPv6 的 ULA / 链路本地 / 回环 | 代理接管 | 跳过 DNS 归类，不弹劫持提示 |
| 不认识的 IP | 未知 | 先不走缓存重读一次状态文件，再下结论 |
| 不在合法集合里，**且** TLS/证书失败，**且** 不属于代理接管 | **劫持** | 记失败，作为提示的依据 |

- Cloudflare 的 IP 段由客户端内置一份（cloudflare.com/ips 公布的 v4/v6）。
- 状态文件读不到时的处理见 7.4：只能标「未知」，**不判劫持**。
- 旧直连入口不一定列在 `legit_ips` 里，客户端也不需要认识它：解析到它、端到端通就照常用。

**劫持提示**：每台机器每 7 天最多一次。文案参考：

> 你所在网络的 DNS 把星芒直连域名解析到了非星芒服务器，已为你改用 CF 线路，不影响使用；我们不会修改你的系统设置。

香港开启后改为「香港/CF 线路」。同时写进诊断页和反馈环境信息（`feedback-environment.ts:268-275` 附近）。

#### 5.1.3 选线规则

- 优先级：L1 → L2 → L3。
- L2 必须四条同时满足（第一批里第 1、2 条永远不满足，所以 L2 不生效）：
  1. 状态文件里 `hk_enabled && hk_recommended`；
  2. 本机已安装的生图技能脚本支持香港地址；
  3. 这次降级不属于「服务端正在处理整体故障」；
  4. 状态文件读得到。

#### 5.1.4 什么时候探测

- 开机。
- 定时：当前线路每 5 分钟查一次（同 `relayRouteRecheckIntervalMs`，`relay-route-controller.ts:37`）。不在最高优先级的线路上时，按 5.1.6 的节奏查更高的线路。
- 系统唤醒或网络恢复。工具线路要**自己注册** `powerMonitor` 的 `resume`（以及网络恢复）监听。`main.ts:3068-3069` 那两个监听在 `if (developmentAcceleration)` 块里（`:3055`），只在有加速时注册、只给加速用，不能挂在它上面。
- 用户点「重新检测」。
- 工具相关的检查报上来的连接级失败：写配置前查模型、工具自检（见 5.2）。只触发一轮探测，不直接计入连败。

#### 5.1.5 降级

1. 当前工具线路**连续 3 轮失败（间隔 15 秒）**，或**判定为劫持 1 次**，进入「准备降级」。
2. **准备降级时，先经应用线路、不走缓存读一次状态文件**：
   - `incident.line` 是当前线路，且 `incident.state` 是 `suspected` / `switching` / `switched`：
     - **不改配置**，首页安静地显示「服务端正在切换线路」（只是状态，不弹窗）；
     - 从首次失败算起 5 分钟后仍不通，才切到 **L3**，不切 L2。
   - `incident.state` 是 `none`，且 `lines.<当前线路>.healthy` 为 true（服务端认为它健康，说明是本机的问题）：按下面第 3 条给这个用户换线。
   - 读不到状态文件，或其它组合（比如 `healthy: false` 但 `incident` 是 `none`）：按 7.4 处理，不分配 L2。
3. **选目标**：
   - 在候选线路里选「本轮探测通过、优先级最高」的那条，**包括比当前更高的线路**。例如在 L3 上时 L3 连续失败、而 L1 已经通了，就直接回 L1。这种情况不受 5.1.6 冷却期的限制，原因记为故障。
   - 目标线路本轮没探测通过就不切（现有控制器也是先确认目标通了才切，`relay-route-controller.ts:309-318`）。
4. 两次切换至少隔 5 分钟，开机那一次除外。
5. **所有候选线路都不通时，不改配置，但要主动提示**（C20）。第一批的候选是 L1 和 L3。
   - 提示放在首页通知里，不能只放在诊断页。按原因分类：
     - TLS 被重置：「你所在的网络掐断了星芒的域名」；
     - 证书错误：「安全软件接管了 HTTPS」；
     - DNS 异常。
   - 「工具同路径探测全失败、Chromium 探测正常」时，要明确说「管理工具能连，但 AI 工具会连不上」。
   - 限频由你定（建议同一原因 24 小时一次），恢复后自动收起。

**为什么要等 incident：** 洛杉矶整体故障时，所有开着的客户端大约 45 秒内就会各自改配置、弹提示，早于服务端切 DNS；等服务端切完，又会各自切回来。服务端会**先写 incident，再改 DNS**。

#### 5.1.6 回升（带退避）

- **失败记录**：按线路记 7 天内「因故障从这条线路降下来」的次数和时间。下文说的「失败一次」就是指一次这样的降级；单次探测失败不算。
  - 可选：再按网络区分（默认网关或出口运营商，只读），避免笔记本在公司网络的失败把家里也锁在 CF。
- **冷却期**：墙钟时间，从最近一次因故障离开这条线路算起，存进工具线路状态文件，跨重启和睡眠都有效。
  - 7 天内第 1 次失败：没有冷却期；
  - 第 2 次：1 小时；
  - 第 3 次：6 小时；
  - 第 4 次及以上：24 小时。
- **切回**：冷却期满后，每 2 分钟探测一次更高的线路，连续 6 次都通（约 10 分钟）就切回。
  - 冷却期内不探测更高的线路，当前线路出故障时除外（5.1.5 第 3 条）。
  - 连续次数沿用现有「数次数、不看钟」的做法（`relay-route-controller.ts:57-60`）：睡眠前后的结果不连成一段。
- **开机快速回升**：那条线路 7 天内**没有失败记录**时，开机 30 秒内 3 次全通就切回。有失败记录的按冷却期走。这是为了避免闲时切回、高峰又坏、用户却关着管理工具。
- **退出时偏稳**：管理工具退出前不做回升。
- **计划内迁出 L2**（`hk_recommended` 变为 false）：L1 探测通就迁回 L1，否则迁到 L3，不弹提示。第一批没有 L2，只留逻辑。

> 冷却期按墙钟算，是为了符合约束 ①：如果要求管理工具连续运行 6 或 24 小时才回升，大多数用户会一直停在 L3。

#### 5.1.7 去重

- 按探测时解析出的 IP 判断：L1 和 L2 解析到同一个入口时，视为同一条线路，不在两者之间来回切。服务端把 xm-direct 指到香港时就会出现这种情况。
- 失败类型是 DNS 或 SNI 掐断时不去重，换个域名可能就通了。
- 响应头 `X-XM-Relay`（服务端计划加，还没上线）只用于日志和诊断。

#### 5.1.8 状态落盘与升级后首次启动

- 工具线路的状态**另存一个文件**，不要塞进 `relay-route-lines.json`。
  - 内容：当前线路；各线路 7 天失败记录和冷却期；最近一次切换的 from / to / 原因 / 触发；各工具上次提示的时间；劫持提示的时间；外部改回计数。
  - 原因：0.2.17 读 `relay-route-lines.json` 时要求 `version: 1`、上限 4KB（`relay-route-controller.ts:385`、`:421-449`，`createRelayRouteConclusionStore`），装回 0.2.17 时必须照常读得出。
- 走 `safe-local-data`（I8）。读坏了当没有，最多开机从 L1 重新开始。
- 失败记录要有条数上限。
- 只存线路 id、原因和时间，不存地址和 IP（与现有约定一致）。
- **升级到 0.2.18 后第一次运行**（还没有工具线路状态文件）：
  - 初值取 `relay-route-lines.json` 里 `solov` 的结论，读不到才用 L1。否则在 0.2.17 里因 L1 不通已经退到 L3 的用户，会被整批写回 L1，约 45 秒后又因故障切回 L3，中间工具用不了，还会弹重开提示。
  - 如果那份文件里 `solov` 最近一次 `changes` 是 7 天内的 `health-failed`，就给 L1 记一次失败，免得刚退下来的人一开机又被拉回 L1。
  - 之后照 5.1.6 走。首启这一次切换算开机跟线，不提示。

#### 5.1.9 日志（C17 的 `relay.route.*` 部分）

- `relay.route.*` 带上：线路种类（应用 / 工具）、切换原因、失败标签、incident 状态，以及 `X-XM-Relay`（有就记）。
- 不记用户 IP。常规日志只记解析结果的类别；具体解析出的 IP 只进本机诊断包（排查劫持要用）。照 I13 脱敏。
- 日志和诊断包要能统计出：每台每天的工具线路切换次数、每个工具每天的提示次数、「由其他工具管理」的次数、迁移重试 12 次仍失败的次数、三线全挂提示的次数和原因。

#### 5.1.10 验收

- 单测：
  - 降级；incident 等待（含 5 分钟后只切 L3）；读不到状态文件；
  - 在 L3 上 L3 失败而 L1 已通时直接回 L1；目标线路没探测通过时不切；
  - 冷却期四档（墙钟、跨重启）；有条件的开机回升；退出前不回升；
  - 升级首启：0.2.17 结论是 `primary` 的，首启不写回 L1；
  - 按 IP 去重；两次切换间隔；归类表每一行；「慢但有进展」不计失败。
- `solov-api` 现有用例原样通过。
- 真机见第 8 节 V7、V8、V14、V15。

### 5.2 应用线路（C7，PR-2）

位置：`electron/relay-line-fetch.ts:196-207`（`createRelayLineFetch` 的 `routed`）、`:216-220`（`fallBack`）、`:228`（订阅线路变化）、`:285-300`（`createRelayObservedFetch`）。

- `createRelayLineFetch` 只跟随应用线路，管理工具自己的请求永远不发往香港。它上报的失败只触发应用线路的检查。
- `:76` 的公告照旧不上报。读线路状态文件的请求也不上报（第 7 节）。
- `createRelayObservedFetch`（写配置前查模型、工具自检）**语义不改**：测的是工具配置里实际写的地址，不换不重发（`relay-line-fetch.ts:281-284`、`main.ts:1207-1208`、`:1494-1495`、`:1581-1582` 的注释）。
  - `solov` 打到当前工具线路上的连接级失败，改为报给工具线路控制器（5.1.4 最后一条）；
  - `solov-api` 照旧报给现有控制器。
- 应用线路的失败要不要顺带触发一轮工具探测，你定。

验收：单测里工具线路取任何值时，`createRelayLineFetch` 发出的请求，origin 只可能是 L1 或 L3。

### 5.3 写配置：定点改写（C9 + (f)，PR-1）

位置：`electron/config-files.ts`；`electron/system-service.ts:7167-7270`（`saveConfig`）；`App.tsx:672-684`（`followRelayRoute`）。

#### 5.3.1 只改地址

线路变了以后只改地址，**不重新查模型列表、不同步 Key、不整份 merge**：

| 工具 | 改哪里 |
|---|---|
| Codex | `[model_providers.<当前 model_provider>].base_url`。**按 `model_provider` 定位，不要写死 `XingmangAI`**：旧版本写过 `OpenAI`，用户也可能用自己起的名字（`config-files.ts:1801-1818` `codexRelayProviderFor`、`:1333-1338`）。定位不到，或者指向保留名（openai 等）时，不改，记日志 |
| Claude Code | 用户级 `~/.claude/settings.json` 的 `env.ANTHROPIC_BASE_URL` |
| Gemini | `~/.gemini/.env` 里 `GOOGLE_GEMINI_BASE_URL` 那一行 |
| Grok | 两处：<br>① `[models].default` 指向的那张 `[model.<default>]` 表的 `base_url`，定位方式同 `config-files.ts:2663-2673`。`[model."grok"]` 只是新模板里的名字，不要写死；<br>② `[endpoints].xai_api_base_url`，只在它当前指向本站某条线路时才改。<br>定位不到就不改，记日志 |
| 生图技能 | 各技能目录 `config.json` 的 `baseUrl`。<br>技能没有来源记录，account 闸门对它不适用，改写条件是：`keyId` 或 `codexKeyId` 是当前账号的 Key（本软件为当前账号写过），且 `baseUrl` 是本站某条线路的 origin，或者缺省（缺省时脚本默认走 xm.solov.cc，`generate.mjs:9`）。缺省的就补写。<br>原先只在同步 Key 时改写（`xingmang-ai-skill.ts:744-764`，`syncXingmangAiSkill`），定点改写不经过同步 Key，必须单独改 |

- **要不要改写，按精确地址判断**：两条同时成立才改。
  - 配置里的地址和工具线路上这个工具的地址不完全相等（`relayProviderBaseUrlEquals`，`relay-sites.ts:279-282`）；
  - 能认出它是本站某条线路或别名（`relaySiteEndpointIdForBaseUrl`，`relay-sites.ts:240-249`）。
  - 落在别名上的配置照样改写成那条线路的域名。别的地址不碰。
- 第一批只作用于来源记录是 account、且 identity 对得上的配置，与现有闸门一致。C8 拍板前不放宽。
- **触发点**：
  - 工具线路变化；
  - 开机对账：配置里实际的线路 ≠ 工具线路，比如上次没迁成，或者是 0.2.17 留下的；
  - 失败后的定时重试（5.3.3）。
- **和整份写入的分工**：
  - 登录、开机 restore 流程不再因为「线路不同」把工具列为 target（`account-bootstrap.ts:432` `routeChanges`、`:339-340`），这部分交给定点改写；
  - Key 换分组、首次写入等仍走整份写入，写入地址用工具线路；
  - 两条路径怎么互斥，在计划里说明。R6 开关（5.3.4）切回整份时，恢复现在的做法。
- 建议定点改写放在主进程里，由上面几个触发点直接驱动。渲染层只收事件，用来刷新首页和决定要不要提示，不再绕到渲染层去跑 `runAccountBootstrap`。你有更好的分法可以在计划里提。
- 沿用现有的事务写入（`config-files.ts:2683-2731`、`:2931-2994` `executeFilePlans`，I9）和配置写入队列（`serializeConfigWrite`），不和用户的手动保存并发。

#### 5.3.2 写完以后

1. **立刻重记来源记录**：source=account，用新的 identity。
   - identity 是路径、actualBaseUrl 和 Key 的哈希（`tool-config-ownership.ts:43-50`，`toolConfigIdentity`）。不重记的话，下次读取会被判为 changed 或 unknown，之后的迁移全被挡住。
   - **原样带上这份配置原来的模板版本号**：先用 `configOwnership.templateRevision()` 读出来，再作为 `write()` 的第 5 个参数传进去。
     - 不传的话，记录里就没有这个字段，读出来按第 0 版算（`tool-config-ownership.ts:101-123`）。
     - 下次开机 `fillToolTemplateDefaults` 会把它当成模板落后（`system-service.ts:7352-7359`）：多做一份整套备份、补一遍缺省项，还会弹「已按新版模板补齐设置」（`App.tsx:341-346`）。
   - 顺序沿用 `saveConfig`：写前先记成保护态，写成后再记 account。中途崩溃时宁可多挡一次。
2. **回读核对，所有工具都要做**：
   - 地址被外部改回：重试一次，记日志。
   - 同一份配置 24 小时内被外部改回 2 次：停止对它自动迁移，首页标「由其他工具管理」（多半是 cc-switch 之类的配置管理器在维护它），等用户自己处理。
3. **备份**：定点改写不进每个文件最多 5 份的轮换（`config-files.ts:2704`，`MAX_BACKUPS_PER_FILE`）。
   - 每个文件单独保留一份「迁移前原件」，即第一次被定点改写之前的内容，来回切线不会把它挤掉。
   - 存在哪里、能不能在「备份」页恢复，由你定，在计划里写清（建议和现有备份放在一起，走 `safe-local-data`）。改备份格式时照 T10，同步照顾备份、恢复、诊断。

#### 5.3.3 失败重试

- 只重试暂时性失败：文件被占用、IO 错误、写后回读不一致。
- 每 5 分钟重试一次，最多 12 次。下一次线路变化或重启时重新计数。
- 闸门拒绝的不重试，重试多少次也不会成功：manual、changed、unknown、官方账号、由其他工具管理。

#### 5.3.4 保留旧路径

- 整份 merge 的旧路径保留，用一个开关切换（R6）。
- 建议开关放进现有的 `service-status.json`（新增可选字段，缺省 = 定点改写），出问题不用发版就能切回。
- **不要放进线路状态文件**，那份由服务端自动写。
- 你有更好的办法可以提。

#### 5.3.5 日志（C17 的 `route.followed` 部分）

`route.followed`（`system-service.ts:7261-7266`）补上这些字段：线路种类（工具）、from / to 线路 id、切换原因、改写方式（定点 / 整份）、回读是否一致、第几次重试。不记地址和 Key。

#### 5.3.6 偏好不一致 (f)

现在 `settledRouteLine`（`account-bootstrap.ts:198-204`）在「设置已改、还没重启」时返回 null，什么都不迁。结果是管理工具自己的流量跟着线路走了，工具配置却卡在原地。

- **修法**：这段时间工具配置跟随**当前生效**的工具线路（和主进程写配置用的是同一口径），不要整个停掉。新偏好照旧重启后生效，设置页「保存后重启生效」的说明不变。
- 另一种做法是让偏好热生效、按新偏好迁移。那样主进程的 routing 快照、两个控制器、应用线路要一起改，改动面大得多。如果你认为应该这么做，在计划里写出改动面，我们再定。

#### 5.3.7 验收

- 单测：
  - Codex 按 `model_provider` 定位，覆盖 `XingmangAI`、`OpenAI`、用户自定义名、定位不到四种情况；
  - Grok 默认模型名不是 `grok` 时也改对；`xai_api_base_url` 指向别处时不改；
  - Claude Code、Gemini、Grok、技能 config.json 各自改对，文件其余内容逐字节不变；
  - 落在退役别名上的配置被改写成域名；
  - 写后来源记录为 account，下一次换线照样能迁；
  - 定点改写后，下次开机不触发补缺省项，也不弹补齐提示；
  - 外部改回时重试一次，24 小时内两次后停；
  - 迁移前原件不被轮换删掉；
  - 暂时性失败每 5 分钟重试、12 次封顶；闸门拒绝不重试；
  - 整个过程一次模型列表请求都不发。
- (f)：设置已改、未重启时，线路变化后工具配置照样跟到当前生效的线路。
- V12：首页显示的每个工具的线路，和配置文件里的实际地址一致。

### 5.4 重开提示（C10、C19，PR-1）

位置：`App.tsx:672-684`（或定点改写完成事件的处理处）；`electron/running-tools.ts:60-118`（`inspectRunningTools` / `describeRunningTools`）；修正 `system-service.ts:7195-7196` 的注释。

`describeRunningTools` 现在给换账号用（`src/renderer-v2/account-switch-sync.ts:294`、`electron/account-source-switch.ts:160`），文案写死了「用上当前账号 / 换回官方账号」（`running-tools.ts:95-108`）。换线提示要给 `RunningToolsGoal` 加一种，或者照它的结构另写一个函数。「如果 X 还开着」的写法可以沿用。

**三个条件同时成立才提示：**

1. 切换原因是故障，不是回升、计划内迁移，也不是开机跟线。
2. 工具检测到在运行，或者检测不了。检测不了的包括：
   - Codex IDE 插件；
   - PATH 之外另装的 CLI；
   - Linux（`cli-process-probe.ts` 不支持）；
   - 从管理工具打开的 Gemini 窗口（C19，按「运行中」算）。
3. 这个工具不会热加载。第 6 节表里写「不用操作」的几行不提示：Claude Code CLI、`codex exec`、生图技能。

**措辞与限频：**

- 检测不了的用「如果 X 还开着…」的说法。
- 每个工具的具体做法照第 6 节表格写。例如：
  - Codex：「新建对话就走新线路，已打开的对话要完全退出再打开」；
  - Gemini 窗口：「关掉这个窗口再打开」。
- 同一工具 24 小时最多弹 1 次，之后只在首页标「需重开」。设置里可以关掉提示。

验收：

- V7-1 里，Codex 在运行时提示一次，Claude Code 不提示；
- 回升时不提示；
- 24 小时内第二次故障切换，只在首页标「需重开」。

### 5.5 外部客户端（C11，PR-1）

位置：`electron/system-service.ts:6553-6581`（`followExternalClientRoutes`）、`:6620-6623`（运行中延后）；`src/renderer-v2/features/tools/external-model.ts:30`（「连接线路暂未改动，完全退出后点「重新检测」」）。

- **第一批**：开着时仍然延后，但改成**定时重试**。
  - 重试放在主进程（外部客户端跟线就在主进程）。可以借 `createTemplateFillRetry` 的结构（`src/renderer-v2/features/app/template-fill-retry.ts:31`），**不用它的参数**：它是渲染层驱动的，10 分钟一次、6 次封顶，约 1 小时后就停了，而 Claude Desktop 往往整天开着。
  - 建议参数：`routePending` 期间每 5 分钟查一次进程，管理工具窗口回到前台时也查一次（同一工具两次至少隔 2 分钟）。一直重试到写成、线路再变、换账号或管理工具退出为止，不设次数上限。如果你评估扫描开销太大，在计划里提上限方案。
- 定时重试**只能缩短**「退出后很快又打开、还是旧线路」的窗口，不能消除这个竞态。要消除，得改成「立即写入 + 提示完全退出」。
  - 这要等我们实测 Claude Desktop、WorkBuddy、OpenCode 退出时会不会把内存里的旧配置写回去（第 10 节）。
  - **实测之前不要改成立即写入。**
- `external-model.ts:30` 的文案跟着改，不再让用户点「重新检测」。

验收：Claude Desktop 开着时换线；用户完全退出后，5 分钟内（或回到管理工具窗口时立即）自动写入新地址，用户不用点任何东西。

### 5.6 首页逐工具显示实际线路（C12，PR-1）

位置：`Home.tsx`；`account-bootstrap.ts:486-490` 附近。

- 每个工具显示它配置里**实际写的**线路：洛杉矶 / CF / 其他地址（香港第二批再加）。
  - 判断用 `relaySiteEndpointIdForBaseUrl` 加精确地址比对，不要用 `relayProviderBaseUrlMatches` 那种「是不是本站」的判断。
  - 落在退役别名上的显示为「其他地址」，或者按待迁移处理。**不要显示成洛杉矶**，它实际不走洛杉矶中转。
- 不要改 `config-files.ts:1732` `matchesRelay` 本身的含义，Key 归属等地方还在用它。另加一个字段。
- 状态标签：「需重开生效」「手动配置」「由其他工具管理」。
- 这是安静的状态标签，不是进度，也不是弹窗，和「首页不摆线路进度」的现有约定一致。如果你觉得和现有界面规划冲突，在计划里提。
- 「一键改到当前线路」按钮随 C8 放到第二批。

验收：V12。

### 5.7 文案、诊断、更新源（C16、C15，PR-3）

**C16 文案与诊断**

- 位置：
  - `electron/diagnostics.ts:1452`（`relayNetworkPassSummary`）、`:1566`（`relayLineNames`）、`:2479`；
  - `src/renderer-v2/registry/connection-routes.ts:5-8`（说明）、`:15-19`（`connectionRouteChoices`）；
  - `electron/feedback-environment.ts:268-275`（`resolveFeedbackRelayRoute`）。
- **新名称（洛杉矶 / CF）只用于 solov。** 上面几处现在都不区分站点：
  - 选项表、线路名表、反馈文案都改成按站点取；
  - `solov-api` 的设置选项、诊断、反馈、首页文案保持「直连 / 默认线路」的说法；
  - 加单测钉住 `solov-api` 的文案不变。
- `solov` 的文案改成三线路的版本，去掉「直连 / 默认线路」的旧说法。**0.2.18 的用户可见文案先不要提香港**：香港还没开，提了会引来咨询。
- 诊断新增。先查现有的 `ENVIRONMENT_OVERRIDE_VARIABLES`（`diagnostics.ts:1090`）和 `workspace-config-overrides.ts` 已经覆盖了哪些，只补缺的：
  - Claude Code 项目级 / 本地级 settings 是否覆盖了 `ANTHROPIC_BASE_URL`；
  - 常用目录是否被 Gemini 信任。不信任时 Gemini 不读 `~/.gemini/.env`，请求会带着中转 Key 发到 Google 官方；
  - Codex `daemon_auto_start` 的状态；
  - 应用线路、工具线路、各工具的实际线路；最近一次切换及原因；状态文件读不读得到、incident 状态；两种探测的结果。

**C15 更新源（可选，做不完放 0.2.19）**

- 位置：`electron/update-feed-route.ts:8-9`、`:25-30`（`usesDirectUpdateFeed`）；`main.ts:1645-1650`（`useUpdateFeedLine`）、`:1837-1847`（`feedRoute`）、`:1863`（服务状态文件跟着更新源走）。
- 保持现状：只有应用线路为 direct、而且是 Windows 安装包时，才用 xm-direct 镜像，其它情况都用包里的更新源。
- 新增：状态文件 `lines.direct.target` 是 `hkg`（或 `X-XM-Relay` 表明 xm-direct 当前落在香港）时，改用包里的更新源，服务状态文件也跟着改。

### 5.8 测试（C18，贯穿各 PR）

- 单测覆盖：两套线路的状态机、归类表、定点改写、迁移闸门不放宽、提示规则与限频、状态文件解析（各种坏输入都当读不到）、`solov-api` 不变。
- **涉及网络的测试一律注入 mock，绝不对线上发真实请求**（AGENTS.md 铁律）。状态文件也 mock。
- 手工测试由我们在真机上做，你给出步骤。场景：Mac 上 Codex 桌面端后台常驻、Codex IDE 插件、Clash TUN、开着 HTTPS 扫描的安全软件、系统代理、`HTTPS_PROXY`。
- 可选：开发构建里提供一个缩短各计时的开关，方便 V14 这类长时间测试。打包版里不生效。

### 5.9 发版（C1，定版 PR）

- 版本 0.2.18，用现成的分批放量（`updater.ts:660-680` `decideUpdateOffer`，加上 `service-status.json` 的 rollout）。放量比例和灰度名单我们给。
- 每个功能 PR 照 AGENTS.md 第 8 节写 `changes/unreleased/` 分片，写明线路相关的行为变化。
- 把写死地址的地方列个表放进计划，标明本期动不动。第一批多半不用动，香港接入时要逐个核：
  - `catalog.ts:80-85`（`providerBaseUrls`）
  - `update-feed-route.ts:8-9`
  - `bundled-skills/xingmang-ai/scripts/mcp-server.mjs:28-32`
  - `bundled-skills/xingmang-ai/scripts/generate.mjs:9`（`DEFAULT_BASE_URL`）
  - `xingmang-ai-skill.ts:18`（`XINGMANG_AI_DEFAULT_BASE_URL`）
  - `external-tool-config.ts:120`
  - `ai-chat-service.ts:566`

---

## 6. 切线后各 AI 工具的用户要做什么（写提示文案用）

分两种情况：**管理工具为本机切线**（改写配置文件），以及**服务端切换 DNS**（配置不变，域名换了指向）。

推荐版本见 `cli-verified-versions.ts:64-122`（`cliVerifiedVersions`）：Claude Code 2.1.291、Codex 0.160.1、Grok 1.0.46、Gemini 0.62.0。下表的实测大多用的是旧版本和非日常界面。标【待实测】的，我们会用推荐版本重测（V17），结论出来后再调文案。

| 工具 | 管理工具会不会在它运行时改配置 | 本机切线后用户要做什么 | 依据 / 可信度 |
|---|---|---|---|
| Claude Code CLI | 会 | **不用操作**，下一条请求就走新地址。正在进行的那一条，如果旧线已断会失败，重发即可。**例外**：项目级 `.claude/settings.json` 或 `.claude/settings.local.json` 设了 `ANTHROPIC_BASE_URL` 时它优先，切线无效（C16 诊断会提示） | 实测 2.1.283（`-p --input-format stream-json`，不是 TUI）+ 官方文档；推荐版【待实测】 |
| Claude Code（在 Claude Desktop 里） | 同 CLI，或同 Claude Desktop | claude.ai 登录的本地 Code 会话读各层 settings，表现同 CLI。第三方推理模式下，Desktop 启动环境里的同名变量会覆盖 settings，按 Claude Desktop 那一行操作 | 官方文档；未实测 |
| Codex CLI（`codex exec`） | 会 | **不用操作**，下次运行生效 | 源码：每次运行都重读配置 |
| Codex CLI 交互界面（TUI） | 会 | 新对话（`/new`）走新地址。想在新线路上继续旧对话：退出后 `codex resume`。开了 Codex 后台服务（`daemon_auto_start=true`，或用过 `codex agents`）的，先 `codex app-server daemon stop`，或者等 30 分钟再 resume，否则会复用内存里的旧线程 | 源码推断；**TUI【待实测】** |
| Codex 桌面端 | 会（main 起不再等它关闭） | 新建对话即走新地址。已打开的对话要完全退出再打开（Mac 上 ⌘Q）。30 分钟内打开过的对话可能还在内存里，完全退出是唯一可靠的做法 | app-server 协议层实测 0.157.1；**真实桌面端【待实测】** |
| Codex IDE 插件（VS Code / JetBrains） | 会，但管理工具**检测不到它在运行** | 新建对话生效；旧对话要重载窗口或重启 IDE | **推断**：插件以常驻 app-server 运行，行为同桌面端 |
| Claude Desktop | 现在不会（运行中延后）；C11 实测后可能改为立即写入 | 完全退出（Mac 上 ⌘Q）再打开 | 官方文档：配置在启动时生效。另：它跟随系统代理 |
| Gemini CLI | 会（写 `~/.gemini/.env`） | 自己开的终端：退出后重新打开（`gemini --resume` 可续对话）。**从管理工具打开的那个终端窗口要关掉**，再从管理工具或新终端打开：窗口里注入了旧地址的环境变量，`.env` 不覆盖已有变量 | 源码（0.65 nightly）；推荐版【待实测】。注入见 `system-service.ts:5927-5934`；Windows 用 `-NoExit` 让窗口常驻（`windows-elevation.ts:647`） |
| Grok CLI | 会 | 退出后重新打开（`grok -c` 或 `--resume`） | 实测 1.0.5（ACP 模式）：同一进程里新开会话也不读新地址。1.0.46 与 TUI【待实测】 |
| WorkBuddy / OpenCode | 不会（运行中延后） | 关闭，等管理工具写入（改造后会定时重试），再打开 | `external-tool-config.ts:377-420`；退出时是否回写配置【待实测】 |
| 星芒AI 生图（MCP / 技能） | 会 | **不用操作**，每次调用都重读 config.json | `mcp-server.mjs` `generateImage` |
| 手动配置的用户 | — | 自己改地址并重启工具 | — |

**服务端切换 DNS 期间**（文案参考；服务端切换还没上线）：

- 配置不用改。
- 从洛杉矶整体故障开始到服务端切换生效，大约有 2–5 分钟请求会失败。工具自带的重试几秒内就用完了，需要用户自己重发。
- 旧入口如果是静默丢包，正在进行的回复可能卡住几分钟。给用户的话：「正在进行的回复卡住超过 1 分钟，按 Esc 后重发即可。」
- 已建立的长连接不会因为改 DNS 而迁走。

**各工具的共同点：**

- 每个工具只能配一个地址，没有备用地址或故障转移。`request_max_retries`、`CLAUDE_CODE_MAX_RETRIES` 都只是重试同一个地址。
- 同一域名有多条 A 记录时，连接被拒会换下一个地址；静默丢包和 TLS 失败不保证会换。
- 不走代理时用系统解析；走代理时由代理解析，本机 DNS 劫持对它没有影响。
- 系统代理：Codex 读；Claude Desktop 读，并以 `HTTPS_PROXY` 交给引擎；Claude Code CLI 只读代理环境变量；Grok 和 Gemini【待实测】。

---

## 7. 线路状态文件（服务端发布，客户端读取）

> **服务端还没上线。** 现在请求会得到 404 或一张网页（CF 入口对这个路径可能回 200 的网页），客户端按「读不到」处理。上线前我们会先放一份手写的静态文件（`hk_enabled: false`、`incident.state: "none"`），时间另行通知。
>
> 它和更新目录里的 `service-status.json`（维护提示、撤回版本、分批放量）是两份不同的文件，别混。

### 7.1 地址

每个入口都提供 `GET /xm-route-status.json`，响应头 `Cache-Control: no-store`（CF 入口也不缓存）：

- `https://xm-direct.solov.cc/xm-route-status.json`
- `https://xm.solov.cc/xm-route-status.json`
- 香港入口上线后同样提供。

### 7.2 格式（v1）

```json
{
  "v": 1,
  "updated_at": "2026-10-xxTxx:xx:xxZ",
  "incident": { "line": "direct", "state": "none", "since": null },
  "lines": {
    "direct":    { "target": "lax", "proxied": false, "healthy": true, "legit_ips": ["<洛杉矶中转 IP>"] },
    "direct-hk": { "target": "hkg", "proxied": false, "healthy": true, "legit_ips": ["<香港中转 IP>"] }
  },
  "hk_enabled": false,
  "hk_recommended": true
}
```

| 字段 | 含义 | 客户端怎么用 |
|---|---|---|
| `v` | 格式版本 | 不是 1 就按读不到处理 |
| `updated_at` | 服务端最后写入时间 | 只用于诊断显示，不据此判断新旧（服务端有心跳告警；第一版是手写的静态文件，按时间判断会永远判成读不到） |
| `incident.line` | 出问题的线路 id（v1 只会是 `direct`） | 与当前工具线路比较 |
| `incident.state` | `none` / `suspected` / `switching` / `switched` | 不是 `none`、而且 line 是当前线路时，降级前等待（5.1.5）。**服务端先写 incident，再改 DNS** |
| `incident.since` | 开始时间或 null | 诊断显示 |
| `lines.<id>.target` | 这个域名现在指向哪台入口（`lax` / `hkg` / 其他） | 诊断显示；C15 用来判断 xm-direct 是否落在香港。不认识的值当普通字符串 |
| `lines.<id>.proxied` | true = 这个域名现在被切到了 CF | 为 true 时，这条线路的合法集合改用 CF 的 IP 段 |
| `lines.<id>.healthy` | 服务端视角的健康状态 | 5.1.5 第 2 步 |
| `lines.<id>.legit_ips` | 这个域名当前的合法 IP | 失败归类（5.1.2）。每一项都要校验是合法的 IP 字面量 |
| `hk_enabled` / `hk_recommended` | 两个都为 true，才允许**新分配** L2 | 只影响新分配和计划内迁出。香港真正的总开关是 DNS（由服务端改指向） |

- 不认识的字段一律忽略。以后加字段会保持 `v: 1` 向后兼容。
- `lines` 里不认识的线路 id 忽略。

### 7.3 读取策略

- **经应用线路读取**：先用当前应用线路的 origin，读不到再试另一条应用线路（L1 ↔ L3），都读不到才算「读不到」。
  - 用 `relayFetch`（带代理分流）按 origin 显式去读。
  - **不要经 `createRelayLineFetch`**，它会自动换线和退回。
- **缓存**：平时缓存 10 分钟。以下两种情况必须不走缓存再读一次：
  - 因故障准备改写配置之前；
  - 遇到「不认识的 IP」时。
- **照 I10**：超时；正文上限（建议 16KB）；不跟重定向；只允许上面几个 origin；内容必须是 JSON 对象。
- 读这个文件失败**不算线路失败**，不上报给线路控制器（和 `/api/notice` 一样处理）。
- 单测一律 mock。

### 7.4 读不到时

- 只禁止新分配 L2，**不迁走现有的 L2 用户**（第二批才会有）。
- incident 当作没有。L1/L3 照常探测和降级，降级按正常节奏切 L3。
- 没有 L1/L2 的合法集合，失败只标「未知」，不判劫持。

---

## 8. 客户端验收清单

- 改 hosts、开代理软件，只在测试机上做。
- 标「真机」的由我们测，你提供步骤。标「依赖服务端」的，要等状态文件上线或我们提供测试入口。
- 编号是我们这边的统一编号，V1–V6 是服务端项，这里不列。

| # | 内容 | 批次 | 怎么测 |
|---|---|---|---|
| V7-1 | hosts 把 `xm-direct.solov.cc` 指向一个返回自签证书的公网测试地址（由我们私下提供）。预期：1 分钟内判为劫持；切到 L3；Codex 新对话可用；Codex 在运行时提示一次，Claude Code 不提示。**不能用回环或内网地址**，那会被归为「代理接管」 | 第一批 | 真机。判劫持依赖服务端状态文件；状态文件没上线时，应在 3 轮失败后切 L3，不弹劫持提示 |
| V7-2 | Clash TUN fake-ip：不判劫持、不弹提示，线路照常 | 第一批 | 真机 + 单测 |
| V7-3 | 系统代理、`HTTPS_PROXY`（进程环境和用户级环境）：额外测代理路径，结果正确 | 第一批 | 真机 + 单测 |
| V7-4 | 开着 HTTPS 扫描的安全软件：标为「安全软件接管」，不判劫持 | 第一批 | 真机 |
| V7-5 | L3 不会因为解析出 CF 的 IP 而被判失败 | 第一批 | 单测 |
| V8 | 开机回升：7 天内没有失败记录时，重新打开后 1 分钟内、L1 通的情况下，配置改回 xm-direct。有失败记录时不立即切回，按冷却期走 | 第一批 | 单测 + 真机 |
| V9 | 关闭管理工具后，Codex、Claude Code、Gemini、Grok 都能正常对话 | 第一批 | 真机 |
| V10 | 不改系统：整个切换过程前后，Windows 注册表 Internet Settings、`HKCU\Environment`、hosts、网卡 DNS、路由表，以及 macOS `networksetup`，都零变化。另外测：加速连接状态下强杀管理工具，系统代理和 PAC 是否还原；重启电脑前后对比 | 切换部分第一批；加速部分只测不改（C14） | 真机 |
| V11 | 迁移后来源记录为 account，下一次换线照样能迁 | 第一批 | 单测 |
| V11-C8 | unknown + 本站线路 + Key 哈希匹配：只改 base_url；Key 不匹配不改；manual 不改，但首页显示实际线路 | 第二批 | — |
| V12 | 首页每个工具的线路，和配置文件里的实际地址一致 | 第一批 | 单测 + 真机 |
| V13 | 生图技能的 baseUrl 跟随工具线路（L1/L3）。L2 上生图正常；本机装的是旧技能脚本时，不会被写成 L2 | L1/L3 部分第一批；L2 部分第二批 | 单测 / 真机 |
| V14 | 不抖动：hosts 每 5 分钟切换一次，模拟时有时无的劫持，跑 24 小时。配置切换不超过 2 次，每个工具最多提示 1 次 | 第一批 | 真机（可用开发构建的缩短计时开关） |
| V15 | 整体故障时不全员切换：开着 N 台客户端，模拟 L1 整体故障并写入 incident。incident 期间没有客户端改配置、没有弹提示；5 分钟后仍不通的只切到 L3 | 第一批 | 单测（mock 状态文件）+ 真机（依赖服务端） |
| V16 | 工具线路在 L2 时，管理工具自己的请求（公告、生图、视频、更新）不发往香港 | 单测部分第一批（应用线路只可能是 L1/L3）；真机第二批 | 单测 / 真机 |
| V17 | 用推荐版本重测第 6 节各行 | — | 我们做 |
| V18 | 回退演练：装着 0.2.18（工具线路状态文件、`relay-route-lines.json` 都在）时装回 0.2.17，0.2.17 照常启动，线路照常。有 L2 配置时的回退按第 9 节的纪律 | 第一批 / 第二批 | 真机 |

---

## 9. 风险与回退纪律（客户端相关）

| # | 风险 | 缓解 | 回退 |
|---|---|---|---|
| R4 | 客户端频繁切换或切错 | 3 轮防抖、incident 等待、冷却期回升、按 IP 去重、C17 日志 | 用户改选「只用洛杉矶」或「只用 CF」；回退客户端 |
| R5 | 写配置时损坏文件，或被其他工具覆盖 | 事务写入；所有工具都回读核对；单独保留迁移前原件 | 从迁移前原件恢复 |
| R6 | 定点改写有 bug | 单测 + 灰度；保留整份 merge 路径，用开关切换 | 切回旧路径 |
| R15 | 第三方配置管理器和我们互相改写 | 24 小时内被外部改回 2 次就停止自动迁移，并在首页标出 | 用户在首页手动处理 |

**回退纪律：**

- 0.2.18 的新状态文件不能让 0.2.17 读坏（5.1.8），保证 0.2.18 可以直接回退到 0.2.17（V18）。
- 香港开启以后，客户端不得回退到不认识香港域名的版本。旧版本会把香港地址当成来源未确认的配置、永远不迁，旧的 MCP 白名单也会拒绝它。必须回退时，先由服务端关香港、把香港域名改指 CF，等 L2 用户迁出以后再回退。
- 加速相关的风险（强杀后系统代理没还原）随 C14 处理，本期只做 V10 的测试。
- 0.2.18 稳定后，服务端会把 0.2.17 列入撤回名单，推动用户升级。

---

## 10. 需要我们给的东西（会卡住你的地方）

| 东西 | 卡住什么 | 现在的状态 |
|---|---|---|
| 线路状态文件上线 | V7-1 判劫持、V15 真机。第一批代码不卡（读不到也照常工作） | 未上线；先放手写的静态文件，时间另行通知 |
| 测试用地址（返回自签证书的公网地址、中转测试入口） | V7-1 等真机测试 | 私下提供，不进仓库 |
| 三个外部客户端退出时会不会回写配置的实测结论 | C11 是否改为立即写入 | 我们测；结论出来之前保持「延后 + 定时重试」 |
| V17 推荐版本实测结论：Codex 桌面端新对话、TUI `/new`、Grok 1.0.46 热加载与 `/settings` 回写、各工具读不读系统代理 | 第 6 节文案细节；Grok 回读核对的预期 | 我们测 |
| C8、C14、C21、C22 的结论；香港域名 | 第二批对应各项（4.3） | 待拍板 |
| `X-XM-Relay` 响应头上线 | 只影响日志和诊断里有没有这一项 | 未上线，读不到就不记 |
| 灰度名单、放量比例、发版审批 | 0.2.18 发布 | 我们来 |
