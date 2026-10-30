# 模块地图 · 主进程：账号、站点、线路与密钥

> 总述、三套跨进程通道和其他分册见 [`../MODULE-MAP.md`](../MODULE-MAP.md)。每个模块一句话，**一律以代码为准**；加了新模块在这里补一行。

> 站点与线路对照，以 `relay-sites.ts` 为准。界面只说「线路1 / 线路2」，设置值、日志、落盘文件里仍是 `primary` / `direct`。
>
> | 站点 id | 是什么 | 账号域 realm | 账号后端 | 线路1 = `primary`（CF） | 线路2 = `direct`（直连） | 「自动」先走 |
> |---|---|---|---|---|---|---|
> | `solov` | 星芒账号（xm 站） | `xm-account` | new-api（`new-api-client.ts`） | `xm.solov.cc` | `xm-direct.solov.cc`（洛杉矶；旧测试入口 `38.147.105.28:8443` 只留作别名认旧配置，不再写、不进加速规则） | 线路2，备用线路1 |
> | `solov-api` | 历史账号（api 站） | `api-account` | Sub2API（`sub2api-*.ts`） | `api.solov.cc` | `api-direct.solov.cc` | 线路1，备用线路2 |
>
> 线路有两套：**应用线路**是管理工具自己的请求走的，两个站都有（`relay-route-controller.ts`）；**工具线路**是写进 AI 工具配置的那条，只有星芒账号有（`tool-route-controller.ts`，候选里多一个永远选不上的香港占位 `direct-hk`）。历史账号的工具配置跟着应用线路走。退役站点 id `sub2api` 只在 `resolveRelaySite` 的容错路径上映射回 `solov`，账号边界上的 `requireRelaySite` 不认它。

## 站点与线路定义
- `relay-sites.ts` — **站点与线路的唯一登记处**：每个站给四个工具的中转地址、官网和取密钥页、账号后端与账号 origin，再加每站两条线路的 origin、退役别名，以及「自动」先走哪条（`relayAutoPreferredLines`）。地址只能从这里来，设置和 IPC 只能选 id，不能给 URL。它零 Node 依赖，经 `ipc-contract.ts` 的值导出进渲染包（I6）。另外管三样：协议和隐私链接、按账号分开的客服企微；外链白名单的来源 `relaySiteExternalUrls`（I12）；加速内核要直连放行的主机 `relayDirectHosts`。线路快照（`createRelayEndpointRoutingSnapshot` / `createToolRouteRoutingSnapshot`）里的偏好开机就冻结，改了设置要重启才生效
- `site-runtime.ts` — 把站点 id 换成固定的运行时定义（站点、realm、后端、账号 origin、AI 地址），并核对四个工具的地址和账号是同一个 origin。它只走 `requireRelaySite`：未知或退役的 id 一律抛错，绝不退回 xm 客户端。main.ts 只用到 `requireSiteRuntimeDefinition`（推断：`createSiteRuntime`、`requireXmSiteRuntimeDefinition` 除测试外未见引用）

## 应用线路（管理工具自己的请求）
- `relay-route-controller.ts` — **「自动」线路怎么定**：每站一条应用线路，切不切只看健康检查（`probeRelayLineHealth`），请求慢或超时不算线路坏了。先走的那条连续 3 次不通、备用那条通了才切；退到备用后，先走的那条连续 10 分钟都通才切回；两次切换至少隔 5 分钟。开机先用上次存下的结论（`relay-route-lines.json`，只存线路 id 和原因，不存地址）。星芒账号第一次开机时直连没通，马上定在线路1（#963）；唤醒、网络恢复、点「重新检测」时两条一起查（#1053）。开机只查星芒账号的站，历史账号的站等它登上了、或者开机恢复它没连上等着重试时才 `ensureWatching` 开始查（main.ts 账号服务的 `onChanged`，0.2.22 性能体检第 11 条），在那之前照旧报上次的结论。Codex 有个对话在线路1 上太大发不出去时，`holdDirect` 查一次线路2、通了当场换过去，24 小时不切回线路1（`holds` 也存在 `relay-route-lines.json`，老版本不认它）；线路2 自己坏了照旧退回线路1
- `relay-line-fetch.ts` — 包在 fetch 外面，把星芒自己的请求（账号、余额、AI 对话/画图/视频）换到当前线路的地址。调用方照旧按线路1 写死地址，所以 `sub2api-relay-backend.ts` 不用改。选「自动」时，网络层失败就当场换另一条重发一次，规则分三种：会改数据的请求（下单、建密钥、AI 生成）只在肯定没送到服务器时才重发，防止重复扣费；只读请求等 4 秒还没回应头，就在另一条上并发一次；失败只报给控制器去查，不直接改线路。`createRelayObservedFetch` 给写配置前查模型、做自检用：不换地址，不重发，只上报

## 工具线路（只有星芒账号，写进 AI 工具配置的那条）
- `tool-route-controller.ts` — **工具线路控制器**（xm 三线路）。候选按优先级排：洛杉矶 `direct` → 香港 `direct-hk`（占位，永远选不上，也不进 `RelayEndpointId`、设置、IPC 和落盘）→ CF `primary`。降级条件是连续 3 轮不通，或判成劫持 1 次（全新安装还没查出结论时，第一次没通、CF 通了就切，查出结论前不落盘，#963）；服务端说在处理整体故障时，先等 5 分钟。回升的冷却期按 7 天内的失败次数定（0 / 1 / 6 / 24 小时）。它和应用线路分开管，因为管理工具走 Chromium 连得上，不等于 Node 里跑的命令行工具也连得上。状态单独存在 `tool-route-state.json`，不碰老版本还要读的 `relay-route-lines.json`。`holdDirect`：Codex 对话在 CF 上太大发不出去时查一次洛杉矶，通了就换，不等三轮、不看切换间隔，不给 CF 记失败
- `codex-payload-limit.ts` — **Codex 对话太大（413）帮客户换线路**：盯 `CODEX_HOME/sessions` 下的会话记录（每个文件只读新写进的末尾，一次最多 256KB，只读单链接普通文件、不跟符号链接），认出一轮结束那行里「413 Payload Too Large」和报错里的地址。地址是线路1 的：星芒账号叫工具线路、历史账号叫应用线路换到线路2，Codex 配置跟过去再提示重开；锁了只用线路1、线路2 不通、配置跟不过去的提示新开对话；地址是线路2 的只提示新开对话。同一个会话只处理一次（`codex-payload-sessions.json`），线路1 上记录过了 80MB 提前提醒一次。日志只记会话 ID、站点、线路和记录大小（`relay.route.payload-too-large`）。接线在 `bootstrap/codex-payload-watch.ts`
- `tool-route-probe.ts` — 工具线路的探测：一条线路要在工具实际会走的每条路径上都通才算通，路径包括无代理、系统代理和各处设的 HTTPS_PROXY / ALL_PROXY。哪条线路都不能全通时，以无代理路径为准。底层探测在 `tool-path-probe.ts`
- `route-failure-classifier.ts` — 探测没通时贴标签：normal / proxy / unknown / hijack。IP 只用来解释原因，不用来判通不通。CF 线路对照 Cloudflare 公布的地址段；fake-ip 和私网地址算本机代理接管；状态文件读不到一律算 unknown，不判劫持
- `route-status-file.ts` — 读服务端发布的线路状态文件 `/xm-route-status.json`，里面有：各直连域名指向哪台入口、有没有被切到 CF、合法 IP、是否在处理故障、香港开没开。它只经应用线路、按本站线路自己的 origin 显式去读（不去退役别名），照 I10 做了超时、16KB 上限、不跟重定向。读不到不算线路失败，结果缓存 10 分钟。注意和更新目录里的 `service-status.json` 是两份文件
- `tool-route-status.ts` — 把工具线路的快照和提示整理成设置快照里的 `relayToolRouteStatus`（服务端在切换、三条线都不通、劫持），不加 IPC 通道。`buildToolRouteReport` 生成检查页导出报告里工具线路那几行：只说线路1 / 线路2，不带地址
- `tool-route-rewrite.ts` — 换线路时只改配置里的那一个地址（TOML / JSON / .env），文件其余字节原样。改完整份重新解析，和「只改了这一个键」逐项比对；对不上或定位不到就返回 null，一个字都不改。`config-files.ts` 和 `xingmang-ai-skill.ts` 在用
- `tool-route-follow-service.ts` — **换线路定点改写命令行工具配置的那一段**（#1070 第 3 步从 `system-service.ts` 原样搬出，`createSystemService` 照旧对外给 `followToolRoutes`、`noteRouteFollowRestart`、`bindToolRouteAccount`、`disposeToolRoutes`）：只管星芒账号；替当前账号写的那份只改地址（`tool-route-rewrite.ts`），和整份保存排同一个队；暂时改不动的过一会儿再试，改完一分钟回头看有没有被别的程序改回去（记在下面的 `tool-route-follow-state.ts`），要重开才生效的给首页一条半小时内有效的提示。星芒退出时撤掉这些定时，连外部客户端那边等着回头看的一起撤
- `tool-route-follow-state.ts` — 换线路定点改写要跨重启记住的每工具状态（存在 `tool-route-follow/`），记这几样：
  - 被外部改回的次数；24 小时内改回两次就标「由其他工具管理」，不再自动改
  - 原件备份过没有
  - 重开提示的节流
  - 暂时失败的重试上限

  只记指纹和时间，不记地址和密钥。`system-service.ts` 在用

## 账号后端对接
- `relay-backend.ts` — **账号后端的统一接口** `RelayBackendClient`，加上能力位 `RelayBackendCapabilities`。`ipc.ts`、`canvas-window.ts`、`chat-credential-coordinator.ts`、`main.ts` 只认这个接口，不认具体后端；方法只收真有调用方的，不预留。DTO 类型直接复用 `new-api-client.ts` 的，两边只用 `import type`，没有运行时循环。文件头说「唯一实现是 new-api」，这句已过时
- `new-api-client.ts` — **xm 站（new-api）的账号客户端，也是 I10 的参考实现**：`performRequest` 有超时、体积上限，`redirect:'manual'` 拒绝 3xx 并核对响应 origin，强制 https；上游文案先脱敏再截断（I13）。它管这些事：
  - 登录（含两步验证、同时登录设备数上限）、续期、退出
  - 余额、用量、看板、任务
  - 密钥增删改查和签发（xm 新签的叫「用户名-分组」，对话的叫「用户名-分组-对话」，见 `isChatKeyName`）
  - 充值、订单、订阅、兑换码
  - 公告、法律文档
  - Codex 启动通行票（`/api/xingmang-tunnel/`，#977）

  端点事实以 `docs/RECON-new-api.md` 为准（T12），测试一律注入 mock fetch
- `new-api-messages.ts` — new-api 从 rc.43 起服务端只回英文加 `message_key`。这里照上游 zh.json 抄了一张中文对照表，只收 rc.40 时本来就回中文的那些句子；认不出的照旧交出英文原话。只有 `new-api-client.ts` 用
- `usage-pricing-parser.ts` — 解析 new-api 用量记录 `other` 字段里的计价和分档表达式（每百万 token 的美元价，未乘分组倍率），表达式长度、档数、条件数都有上限。只有 `new-api-client.ts` 用，类型经它转导出
- `usage-date-range.ts` — 用量查询的日期范围：按时区算「今天」，缺省是近 7 天，校验日期和时区格式。主进程（`ipc.ts`、Sub2API 后端）和渲染层共用
- `sub2api-relay-backend.ts` — **历史账号站（Sub2API）的 `RelayBackendClient` 实现**，把 Sub2API 的接口套进和 xm 一样的 DTO。Sub2API 的金额本来就是美元，这里用 `quotaPerUnit=1`，防止误乘 new-api 的 500000。能力位里没有注册、找回密码、会话管理这些。**按硬规矩不改**：请求地址写死线路1，换直连靠 `relay-line-fetch.ts`；法律文档固定走 xm
- `sub2api-account-client.ts` — Sub2API 的底层 HTTP 客户端和会话执行器。fetch 必须由外部注入（没有默认的生产 fetch，地址也不能由渲染层给）；10 秒超时、体积上限、`redirect:'manual'` 拒绝 3xx（I10）。令牌轮换后会核对身份，不让会话串到别的账号上（`Sub2ApiIdentityError`）。历史账号自动签工具密钥也在这里（`provisionSub2ApiManagedCliKeys`）
- `sub2api-announcements.ts` — 解析 Sub2API 公告：限条数、总大小不超过 4MB、剥掉控制字符、只留给用户看的字段，再按发布时间重排成统一的 `RelayNotice`
- `key-secret-summary.ts` — 把密钥变成掩码显示加 sha256 指纹；上游给的已经是掩码时，只留它本来露出的尾巴。指纹只在主进程里做精确比对，永不过 IPC（I3）。两个 sub2api 模块在用

## 双账号域（realm）与登录凭据落盘
- `realm-account.ts` — **双账号域的后端无关契约**。两个 realm：`xm-account`（`solov`、new-api、xm.solov.cc）和 `api-account`（`solov-api`、sub2api、api.solov.cc）。还定义保存的账号和凭据长什么样（new-api 存 cookie，sub2api 存 access/refresh token），以及统一的错误码和中文文案。无 Node 依赖。`RealmSavedAccount` 带着凭据，永不进 IPC、渲染层或日志（I3）
- `realm-account-service.ts` — **账号服务的总调度**，管这些事：
  - 登录，含两步验证的第二步（flow token 只存在主进程内存里）
  - 退出、切换和删除已保存账号
  - 开机恢复：分清「登录确认失效」和「联不上，先留着」
  - 从老文件迁移

  切到另一个身份前，先等宿主手上的活做完（`quiesce`）。由 main.ts 装配，按站点建 new-api 或 Sub2API 客户端
- `realm-account-vault.ts` — 已保存账号库的纯逻辑：最多 16 个账号，管登录名提示和 `activeId`，整份加密后原子替换。`realmStorageScope` 用 sha256 生成各账号的数据目录名，原始 ID 和 origin 永不拼进路径。存储和加密都由外部注入；`createSessionRealmAccountVault` 是给没法安全加密的电脑用的版本，只活到软件退出
- `realm-account-vault-file.ts` — 把账号库落到 `userData/realm-accounts-v2.dat`：safeStorage 加密，safe-local-data 原子写（I8）。解不开时先复制一份 `.unreadable-*.bak` 再重建，绝不改名挪走原件，免得又把老 cookie 导回来。老的 `saved-accounts.dat` 和 `account-session.dat` 不动
- `vault-recovery-notice.ts` — 账号库重建时做两件事：记日志（带备份文件名），通知界面一次（不带文件名，也不带账号内容，I3 / I13）。同一次启动里不重复弹
- `realm-data-roots.ts` — 按 realm 算出账号自己的数据目录，包括对话密钥、托管密钥缓存、画布项目/运行/视频任务、缩略图、生成作品。xm 保留历史路径，好原地升级；历史账号一律放在 `realms/api-account/` 下面，这样两个 realm 里同号的用户永远碰不到同一份文件
- `realm-service-dispatch.ts` — 用 Proxy 把调用转给当前账号所在 realm 的服务实例。每次方法调用只解析一次，方法里 await 到一半切了账号，也不会中途换实例。main.ts 用它包了一大串按账号分开的服务
- `saved-accounts.ts` — 老版本的「已保存账号」文件（`saved-accounts.dat`，safeStorage 加密，只存 xm 的 cookie）。现在只用作 `realm-account-service.ts` 迁移进新账号库的来源；`savedAccountId` 也被拿来算账号 id
- `account-session-store.ts` — 老版本的单账号登录凭据（`account-session.dat`，safeStorage 加密，只存 refresh cookie 和 userId，解不开就静默当未登录）。现在 main.ts 只读它做迁移。它导出的 `SafeStorageLike` / `RuntimeLogLike` 两个类型被好几个存储模块共用。
- `account-credential-store.ts` — 「记住密码」的登录名和密码，safeStorage 加密，存在各 realm 目录下的 `account-credentials.dat`。明文只走 `account:get-remembered-login` / `account:set-remembered-login` 两条专用通道，且不进日志（I3 的已登记例外，I13）

## 账号生命周期守卫
- `account-startup-gate.ts` — 定启动画面最多等账号恢复多久：恢复结束和预算用完，哪个先到算哪个；确定断网就不等。预算先用完时记一笔，恢复结束后补发一次会话
- `account-restore-retry.ts` — 开机恢复登录联不上时的重试节奏：30 秒、2 分钟，之后每 5 分钟一次，直到恢复成功、确认登录失效，或用户自己登录/退出
- `account-work-gate.ts` — 切账号时记住所有正在跑的宿主操作（含它们最后的本地写入），`whenIdle` 等它们全部结束。操作结束时会话代数变了，就抛「账号上下文已变化」
- `account-identity-tracker.ts` — 判断「换了一个人」：站点 + 用户 + 会话代数拼成身份串，只在它变了时返回 true。续期、充值后刷新余额都不算换人
- `account-usage-tracker.ts` — AI 请求结束时通知界面刷新余额。只发 `realm:userId` 这个范围，不带凭据、提示词、模型或用量原文；旧账号的请求结束一律忽略

## 密钥签发、写进工具与额度
- `account-cli-provisioner.ts` — **登录后给每个工具签密钥并写进工具配置**（`syncManagedCliKeySummary` / `configureManagedClis`）：按服务端实际可用的分组选组，复用缓存的密钥，挑默认型号；密钥换了分组的工具（买了订阅、订阅到期、分组改名）要重写配置（`regrouped`）；三把都缓存时一天查一次分组，分组被删就换组重签，新密钥写进工具后删掉星芒签的旧那把（#1074）。全程核对账号没被切换，切了就停。由 `ipc.ts` 调用
- `managed-cli-key-store.ts` — 托管工具密钥的本地缓存，safeStorage 加密，按站点和用户分开存。缓存是为了复用，不是为了保护：new-api 的密钥列表只回掩码，没有缓存就得每次重签（见 AGENTS.md 第 7 节的例外）。老文件里的老分组名照新名字换（xm 10-16 删了老名字）；坏文件隔离起来，不清空；同一次运行里切账号，靠内存副本复用
- `chat-credential-coordinator.ts` — **AI 对话和画图按分组按需签发、缓存密钥**。画布和聊天用的密钥只在主进程解析，绝不下放到渲染层（I15）。命中缓存先验一遍，密钥被吊销或额度用完就处理掉，账号一切换缓存就失效。对话签的密钥叫「用户名-分组-对话」（#1106），缓存里同组工具的那把不再复用（#1077）
- `account-key-options.ts` — 回答「账号 → 密钥」里某个工具现在装的是哪把：只回掩码预览、真实分组，以及自动签发会用的名字和分组，不回明文（I3）
- `account-key-quota.ts` — 单把密钥额度的几件事：金额和后端单位互换（new-api 要乘 `quotaPerUnit`，Sub2API 本来就是美元；集中在一处，防止少乘或多乘），到期时间原样回写，认出「这把密钥自己的额度用完了」并给出文案，按工具分账的上限。主进程和渲染层共用
- `relay-quota-failure.ts` — 分清三件事：余额不足、密钥额度上限用完、密钥失效。只认 new-api 和 Sub2API 源码里写死的报错句子和错误码，刻意不认光秃秃的 insufficient_quota。零依赖，渲染层拿同一组句子再认一遍（I6）
- `account-source-switch.ts` — 首页「切到当前账号 / 切回官方账号」的编排：先备份，再写配置，再跑连接自检；自检明确说配置不对，就整体恢复到切换前（I9 里跨文件回滚的那一层）。只编排，不碰文件，每一步都由调用方注入
- `connection-check.ts` — 针对工具「装好了但一跑就报错」的连接自检：用工具配置里真正写着的密钥和模型发一次探测，判断卡在哪一层（未配置 / 本地配置 / 网络 / 密钥 / 额度 / 分组 / 模型 / 协议 / 服务）。探测计划带着密钥，只留在主进程；结果先脱敏再截断（I3 / I13）。`siteId` 只给日志和客服看，界面上不出现站点名
- `models.ts` — 把 `/v1/models` 这类回应解析成模型名列表：去重、排序，名字长度和条数都有上限。`connection-check.ts` 和 `system-service.ts` 在用
- `sensitive-clipboard.ts` — 复制出去的密钥、找回密码后拿到的新密码，60 秒后从剪贴板清掉。只清自己放进去的那段，软件退出前（`prepareToQuit` 里的 `flush()`）立刻清：剪贴板读回比对是异步的，will-quit 里来不及。`ipc.ts` 在用

## 计费、充值、订阅、公告
- `payment-window.ts` — 充值和订阅付款用的独立窗口。后端给的付款表单、URL、二维码都先校验；页面导航只放行白名单 origin 和回调域 `api.solov.cc`（I12）；只有后端查到的订单状态才算付款成功。关了窗口还会在后台继续问 15 分钟
- `payment-methods-off.ts` — 充值方式开关（`service-status.ts` 的 `paymentMethodsOff`）：从充值信息里去掉这台电脑该藏的付款方式，页面开着时才被藏掉的、点付款时拦下。只藏软件里的，站上不动
- `payment-status-reader.ts` — 查订单状态前，先把订单绑到下单时的站点、用户和会话代数上；任何一样变了就报 STALE，不再问
- `subscription-summary.ts` — 回答「当前账号有没有一份现在就能扣的订阅、还剩多少、哪天到期」。买了订阅的客户钱包常常是 0，所以首页、低余额通知和托盘读的是这同一个判断。它进渲染包，不许依赖 node 或 electron（I6）
- `announcement-read-store.ts` — 公告已读标记的本地存储，只认 `xm-account:<userId>` 这个范围。IPC 传进来的参数先校验格式和条数（I5）；文件坏了就报错并保留原件，不拿空数组覆盖

## 服务状态文件与发版安全网
- `service-status.ts` — 读更新目录上的 `service-status.json`，地址从安装包里的 `app-update.yml` 推出来。里面有维护提示、撤回版本、分批放量、最低版本、换线路的改写方式、xm 分组对照、型号表、已知问题提示、充值方式开关、远程关功能。这份文件只能让客户端少做事或多说一句；读不到就当没有，绝不拖慢启动。平时 15 分钟读一次，维护期间 5 分钟一次（I10：超时 + 16KB 上限）
- `remote-features.ts` — 远程关功能（`service-status.ts` 的 `featuresOff`，商业级差距 G04）能关的名单和关掉后那几句话：视频剪辑、手机遥控、Mac 闲时装、托盘省内存、网络加速的新连接、Codex 桌面端中文补丁、每个工具的安装和打开。名单写死，状态文件只能挑几样关、打不开任何东西。它进渲染包，不许依赖 node 或 electron（I6）
- `remote-feature-gate.ts` — 主进程这头的开关：跟着更新快照里的 `featuresOff` 走，点了才做的事用 `assertOn`（状态文件第一次没读完时最多等 2 秒）、同步的 IPC 处理器套 `runWhenOn`，后台的事用 `isOff`；`main.ts` 组装，接进安装、打开、视频、加速、手机遥控、闲时装、托盘省内存
- `release-guard-store.ts` — 把最近一次读成功的撤回名单和放量比例记到本地 `release-guard.json`（#1055），开机先用它。不记最低版本。读回来的内容用状态文件同一个解析器重新校验

## 星芒 AI 技能与画图 MCP
- `xingmang-ai-skill.ts` — 生图技能（文件夹和技能名都叫 `images`，0.2.20 及以前叫「星芒AI」），管这几件事：
  - 安装：把随包的技能文件装进 `~/.agents/skills/images`；Claude、Grok 的目录本来就有时，各自再复制一份
  - 改名：登录同步时把老的「星芒AI」文件夹原地改名成 images；客户自己有 images 的地方一直用旧名；退回旧版又装出来的、早期装进 `~/.codex/skills` 的旧名文件夹，没动过就收掉；Codex 里改名前写的开关条目跟着换到新路径
  - 登录后：把地址、分组、画图模型（先 gpt-image-2.5-flare，没有再用 gpt-image-2）和密钥写进技能的 `config.json`
  - 换线路：只改 baseUrl（`followXingmangAiSkillRoute`）
  - Codex 切到 ChatGPT 官方账号时关掉技能，切回来只打开自己关的那一次
  - 退出登录时清掉密钥

  给界面看的版本会剥掉 apiKey（I3）
- `xingmang-ai-mcp.ts` — 星芒画图 MCP（`xingmang-image`）写进各工具 MCP 配置的那一段：启动方式、Codex / Grok 的 TOML 写法、Claude / Gemini 的 JSON 写法、Claude 的工具权限。只有从星芒技能目录（`images` 或改名前的「星芒AI」）启动随包脚本的条目才算自己的，同名的别的条目不碰。Codex 选着 ChatGPT 账号时的 config.toml 和存着的两份配置里，登记过的那条只换位置、不新登记。密钥不进 MCP 配置，脚本按路径去读技能的 `config.json`

## 官方账号（不是星芒账号）
- `official-account-identity.ts` — 从 Codex `auth.json` 里的 JWT 解码出邮箱和套餐名，只用来显示，不验签（这不是认证决定）。令牌本身不出主进程（I3）
- `official-account-usage.ts` — 用 Codex 本机的 ChatGPT 令牌去 chatgpt.com 查官方 5 小时限额和周限额还剩多少（8 秒超时、256KB 上限、不跟重定向，I10）。`system-service.ts` 在用
- `official-credential-service.ts` — **官方账号与当前账号来回切的那一段**（#1070 第 3 步从 `system-service.ts` 原样搬出，`createSystemService` 照旧对外给 `switchToOfficialAccount`、`setOfficialSourcePreference`、`restoreOfficialCredentials`、`adoptRestoredConfig`、`alignRestoredAccountSource`）：接中转时把 Claude Code 登录留下的官方 Console Key 挪到一边（它会顶掉当前账号的 Key），切回官方时放回，写配置失败就撤回这一步；恢复备份后按恢复出来的那份重新登记来源、对齐「选了官方账号」的记号；Codex 跟着账号开关星芒AI技能。都排在写配置那一条队里，保存配置也用这里的挪开、放回和撤回

## 网络环境检查
- `stale-proxy-environment.ts` — 找出并清掉「指向本机、代理软件却没开」的 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`。这种残留设置下，本软件自己联网正常，从这里打开的工具和 npm 却全连不上。Windows 上读、清当前账号和整台电脑的设置，用固定路径的 PowerShell + `execFile` + `trustedCommandEnvironment`（I1 / I2 / I14）。Mac 上的同一套规则在 `macos-platform.ts`，改这里要一起改
- `certificate-trust-probe.ts` — 检查页的「安全证书」一项：用跑工具的那个 Node.js 握手两次，一次只用自带根证书，一次加上 `NODE_USE_SYSTEM_CA=1`，两次一对比就知道是不是公司证书在拦截、星芒替工具开的「信任系统证书」生效没有。`diagnostics-network-checks.ts` 在用

## 清单里与账号无关的小模块
- `login-launch.ts` — 识别开机自动启动：Windows 看 `--launched-at-login` 参数，Mac 读登录项标记。开机拉起时窗口留在托盘，工具检测、检查更新、签密钥这些后台事推到用户点开窗口或开机 3 分钟后再做。这里也定义 Windows 开机项的名字 `windowsAppUserModelId`，卸载清理必须用同一个
- `device-profile.ts` — 按内存（不到 7GB）和核数（2 核及以下）判低配电脑，只用来在本机挑更轻的视觉效果。结论不记日志，也不上报
- `exported-file.ts` — 「在文件夹中显示」刚导出的文件之前再核一次：必须是绝对路径，`lstat` 看仍是普通文件（被换成链接就不跟过去）
- `session-workspace.ts` — 打开会话记录里的工作目录前，确认它真是个目录：被改过的 `cwd` 如果指向可执行文件，`shell.openPath` 会直接运行它。这里刻意跟随联接，不照搬配置目录那套「拒绝 reparse」，好和旁边「接着聊」按钮的判断保持一致
- `probe-failure.ts` — 单个探测抛错时，转成「检测失败」的说明，不让它被当成「没装」。单独做成叶子模块，免得 `codex-desktop-service.ts` 反过来依赖 `system-service.ts`
