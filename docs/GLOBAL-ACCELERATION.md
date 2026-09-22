# 游戏加速：界面、计时与接入边界

界面名称统一为“游戏加速”。当前系统代理仅覆盖遵循系统代理设置的游戏、启动器和下载请求；退出游戏不会自动停止本软件的连接和计时。TUN 尚未接入，不宣称覆盖所有游戏流量。

2026-09-14 用户确认免费时长由 1 小时调整为 20 分钟，0.2.3 先发布本机计时版，当时 Windows 安装包带私有节点、节点不上传 GitHub。每账号在本机累计 20 分钟，停止保留剩余、设备之间不同步。当前仅系统代理，TUN 尚未接入。

当前节点策略已由产品所有者调整：现有 12 条发布线路的清洗后配置与 SHA-256 收录在 `bundled-acceleration/profile.yaml`、`bundled-acceleration/profile.sha256`，Windows 与 macOS 打包共用，无需再私下传递节点文件。内核、资源准备 JSON 和五文件输出目录仍留在仓库外；普通构建与 CI 不会自动附带内核或启用线路。具体准备方式见 [内置加速节点说明](../bundled-acceleration/README.md)。

## 已完成

- 侧栏日常组和命令面板入口，现有固定 1280 DIP 布局；完整亮/暗主题。
- SVG 网络球体、连接轨迹、额度圆环、开始/停止按钮、本次与累计时长；未知状态不填造延迟或节点。
- 默认系统代理，TUN 开关在未连接时可选；连接期间锁定，避免显示的模式与实际网络状态不一致。
- 免费累计 20 分钟的交互：连接成功才消耗，停止后冻结，恢复继续扣剩余，耗尽触发停止。暂停不重置额度，页面隐藏仍保持会话；独立到期任务不依赖前台一秒定时器。
- `acceleration-contract.ts` 中的三种主进程操作：读状态、开始（scope + mode）、停止；可信 IPC 参数校验和 renderer-safe DTO，不返回节点凭据。
- `acceleration-service.ts` 校验当前账号、模式、响应；串行化启停，处理重复点击、迟到响应和账号切换清理。账号切换/正常退出前先请求停止，异常退出仍须未来真实服务的租约兜底。
- renderer controller 使用单调时钟投影剩余时长，前台每秒展示、每 15 秒读取状态，**不把本地计时当计费依据**。停止响应未确认时仍展示实际连接状态；失败可以重试。
- 独立 mock 交互预览，实际正式入口在没有 backend 时返回「线路准备中」、未知剩余额度，并拒绝开始；不会改变系统代理或创建隧道。
- Windows 本机发布包通过私有资源启用真实 Mihomo backend，额度来源标记为 `local-device`，界面说明本机累计；开发配置的测试模式仍标注「本机联调」。缺少内置资源的 CI 测试包保持未开通。
- 加速 controller 常驻应用外壳，底部网络位置在连接成功、线路变化、确认停止/耗尽后自动刷新，切换页面仍联动。检测中清除旧位置展示，停止失败不假报直连；网络恢复和回到窗口可刷新（焦点刷新间隔 30 秒），底部位置可点击重试。
- 连接前可展开线路面板，查看线路地区和最近一次 Ping，单独检测某条线路延迟并手动选中。列表首项「智能分配」清除固定线路选择，连接时自动测速选最快；重新点击已选固定线路保持选择，不再暗含取消。智能分配固定排在首项，不参与线路 Ping 排序，数量仅统计真实线路。开始时仅固定线路携带 `lineId`，智能分配不携带。连接/停止时线路选择锁定。

## 底部网络位置刷新

`system:refresh-network-location` 是单独的可信 IPC，只探测当前网络出口，不触发 CLI/安装版本全量扫描。主进程先重载默认 Electron session 的现有代理配置（等待上限 2.5 秒），随后使用 `net.fetch` 访问固定 HTTPS 位置服务，遵循当前系统/应用代理；保留请求超时、大小限制、禁止重定向，并禁用缓存和 cookies。

普通系统扫描仍使用 10 分钟位置缓存；显式刷新绕过缓存并使旧探测失效。旧在途探测跟随新结果，renderer 合并完整扫描和单独刷新时按 `checkedAt` 选择较新结果，避免慢 CLI 扫描把位置回滚。连接指纹不包括倒计时或每次状态轮询的时间戳，因此不会每秒重新出网。

位置显示来自网络探测的国家和 IP，不拿节点名称/标注地域替代；失败显示「网络位置未知」。在分流模式下，这是**位置探测请求的出口**，不代表所有应用或目的地址都使用同一出口。当前预览使用保留的文档 IP 演示“中国 → 新加坡 → 中国”，与上文的实际网络服务开通状态区分。

新增状态协调 mock 测试覆盖连接/断开/失败/线路切换/迟到回包，浏览器验证连接和停止后的底部联动、跨页保留、不触发全量扫描、手动重试和停止失败。亮暗主题截图位于本地 `artifacts/acceleration/network-active-{light,dark}.png`；离线交互原型同步了同样的检测中/成功/点击刷新行为。

## Windows 本机真实联调

Windows 开发版主进程在未打包时读取 userData 下的 `acceleration-development.json`，内容只有 YAML 路径、内核路径及 SHA256。开发配置仍须显式填写绝对 `profilePath`，可指向仓库固定节点文件或外部节点；资源准备脚本的默认节点规则不改变开发配置契约。`acceleration-development-host.ts` 将其投影后交给独立 worker；源 YAML 和密码不跨 renderer IPC。

`acceleration-mihomo-runtime.ts` 在独立私有目录复制并校验内核，动态分配回环代理/控制端口；对节点测速后选择最快可用线路，再用实际 HTTP CONNECT、正常目标站点 TLS 验证及 HTTPS 204 探测确认转发成功。`platform/windows-system-proxy.ts` 保存 WinInet/PAC/WPAD 和注册表原值，在设置前写入恢复记录；用户级原生 mutex 和包含 PID/进程创建时间的租约防止开发实例互相覆盖。停止先恢复代理、再关闭内核，恢复未确认时保留进程和记录并重试。

`acceleration-development-backend.ts` 连接成功后才按单调时钟扣除本机测试额度，独立任务负责耗尽停止，窗口隐藏不影响计时。已用时长持久化，旧 1 小时账本按历史消耗迁移到 20 分钟，不重新赠送；异常中断按本机记录保守结算。

worker 在 Windows 使用 `detached: true`、隐藏窗口和独立 IPC 通道，使父主进程退出后仍能恢复代理，再停止内核和自身。普通 fork 在 Windows 下会随父进程 Job 一起结束，已通过无网络回归和真实代理断连实验覆盖。worker 自身也被强制终止时仍需要下次启动利用恢复记录处理，不能把本机联调视作完整后台服务。

本轮真实联调结果位于本地 `artifacts/acceleration/development-smoke-result.jsonl` 和 `development-crash-result.jsonl`：

- 正常流程：idle → active → idle；自动选择日本线路，单次 330 ms，位置服务实测出口国家为 JP。
- 停止后原代理四项设置完整恢复，ProxyEnable 为 false，恢复 journal/lock 已删除。
- 父进程直接退出：worker 自动恢复原代理、结束内核、清除本次运行目录，外部进程复核通过。
- 实测使用隔离的本机测试 scope，未登录或请求任何生产账号服务，没有使用用户聊天/API 凭据。临时验证程序改为文件日志和隐藏启动，避免 GUI 进程输出管道关闭造成 EPIPE。

TUN 当前明确标记为未接入并禁用开关。账号时长 API、节点端强制到期及 macOS 系统代理/TUN 仍未接入；当前发行版采用用户明确选择的本机账本方案，不能宣称跨设备服务端限额。

## macOS 本地源码适配（尚未发布）

在 0.2.3 源码上新增 Mac 分支，保留以上 Windows 发行记录。开发配置、worker 入口和资源读取支持 Darwin；共用节点解析器、CONNECT 探测、选线及 20 分钟账本。`native/macos-system-proxy.swift` 与 `electron/platform/macos-system-proxy.ts` 提供固定 JSON 操作和原生恢复流程；详情见 [macOS 开发说明](MACOS_DEVELOPMENT.md#本机加速开发)。

Mac 资源清单采用 `version:2`、`platform:"darwin"`、`arch:"arm64"|"x64"`、`coreFile:"mihomo"`，其余节点、许可与哈希字段沿用已有方案。Windows `version:1` 和 `mihomo.exe` 保持兼容。资源准备工具新增显式平台/架构参数，运行及构建前均拒绝不匹配目标；内核、资源准备 JSON 与生成目录仍位于仓库外。原生 helper 与 Mihomo 分开验证，安装包阶段的签名及最终内容验收仍需在用户另行要求打包后执行。

本轮验证涵盖：Mac 资源错平台/错架构、篡改拒绝、native helper 双架构编译、代理原值/PAC 保留、外部变更、授权取消、并发实例、父管道断连、硬杀重启恢复、持久化提交成功但应用失败后的重试，以及恢复记录大小限制。测试通过不等于真实网络切换、Intel 实机或安装包验收。

## 加速资源发布方式

从项目目录运行 `scripts/stage-acceleration-bundle.cjs`，提供仓库外的资源准备 JSON、已固定 SHA256 的内核、准确源码版本和完整 GPL v3 许可。JSON 省略 `profilePath` 时，脚本读取仓库固定的 `bundled-acceleration/profile.yaml` 并验证配套 `profile.sha256`；显式路径可以是该固定文件或仓库外自定义节点，其他仓内文件不接受。脚本只导出清洗后的内联节点，生成固定五文件资源目录；输出目录必须在项目之外且为空，不合并完整 Clash 规则、订阅或控制配置。

Windows 走 `release:build:unsigned`，并用 `XINGMANG_ACCELERATION_BUNDLE_DIR` 指定准备好的五文件资源目录。macOS 的免费分发入口 `npm run dist:mac:free`
不认这个环境变量（环境清洗会把它剥掉，避免上一次构建残留决定本次资源），改用
`--acceleration-arm64` / `--acceleration-x64` 两个命令行参数显式开启，并分两次单架构构建后合并产物；
默认不传参数时出的 macOS 包仍然不含 `resources/acceleration`。详见
[发布手册第 2 节](RELEASING.md#2-macos-双架构加速资源)。

`electron-builder.config.cjs` 将内核/节点哈希固定到 ASAR 内的 package metadata，打包前再次验证。主进程 `readBundledAccelerationConfig` 对比外部清单和 ASAR pins，并验证文件哈希；worker 每次读取节点配置仍核对哈希。开发 userData 配置不能启用正式包。包内附 Mihomo GPL v3 许可和对应源码地址。

正式包保持 RunAsNode=false、OnlyLoadAppFromAsar=true 等现有 fuse，使用自身可执行文件的固定 `--xingmang-acceleration-worker` 入口启动独立 Electron helper，仅存在父 IPC 时加载 worker，完全跳过窗口和普通主进程初始化。helper 使用 detached 方式，父进程退出后收到 IPC 断连并恢复代理；不能用随父进程立即终止的 utilityProcess 替代。不同于开发模式，不依赖客户另装 Node.js 或 Clash。

已授权的共用节点连接凭据现随清洗后配置进入 GitHub，并在显式准备资源后随安装包分发；原始 Clash 文件、订阅地址和本机控制凭据不进入仓库。主进程与 renderer IPC 的边界保持不变，不向界面或诊断返回节点密码。本机计时记录仍可被重装/换设备绕过，不构成跨设备服务端额度。

## 客户正式服务仍需完成

真实服务需负责：按账号保存总额度/剩余额度（新安装/换设备不能重新领取）、会话租约与心跳、并发设备规则、失联/休眠/耗尽结算；普通代理模式设置和恢复系统代理，TUN 模式按 Windows/macOS 安装和驱动能力启停及清理路由/DNS。节点凭据留在主进程，退出/崩溃要有恢复机制。不能仅依赖 renderer 倒计时约束免费时间。

正式实现开始/停止成功分别以真实隧道/系统代理就绪和停止确认为准；失败不授予假连接、不重新发放额度。停止失败时保留运行状态并提示重试。线路延迟由真实探测提供。

## 共享 Clash 上游接入（2026-09-14）

用户指定的私有 YAML 作为客户共用上游来源，原文件留在运营者本机，不复制到仓库、前端或安装包；当前入仓的是仅保留可用连接字段的清洗后配置。2026-09-14 接入时新增两部分：

- `electron/acceleration-clash-config.ts`：解析内联 Hysteria2 节点；限大小/数量、拒绝 YAML 标签和别名，不继承订阅、规则、脚本、文件或运行时设置。去除流量/重置/到期占位，按连接参数去重；对外标签只由固定地域表和编号生成。运行时节点密码留在主进程连接对象及短暂内核运行配置，不跨 renderer IPC。
- `scripts/probe-acceleration-nodes.cjs`：运营诊断工具，复用上述模块及安全文件读写。使用指定的本地 Mihomo、独立临时目录和随机回环控制端口；强随机 controller secret，额外验证错误 secret 得到 401。代理监听关闭（`mixed-port: 0`），TUN/DNS 接管关闭，不更改系统代理。对固定公开 HTTPS 探测地址进行最多 3 路并发测试，限制超时/回包大小，不输出原始内核日志。退出及 SIGINT/SIGTERM 收到后停止子进程，确认退出才删除临时配置。

手动真实探测结果保存在本地忽略目录 `artifacts/acceleration/node-connectivity.json`：

| 项目 | 结果 |
| --- | --- |
| 原始条目 | 35，均为 Hysteria2 |
| 订阅状态占位 / 重复连接 | 3 / 20 |
| 去重后连接配置 | 12，覆盖 HK/TW/SG/JP/KR/MY/TH/IN/US |
| 连通性 | 12/12 可用 |
| 探测目标 | `https://www.gstatic.com/generate_204` |
| 单次延迟 | 357–902 ms；本次新加坡最低 |
| 测试网络 | 系统代理已关闭，无 Clash TUN 适配器或默认路由接管 |
| 清理 | 临时内核已退出、临时目录已移除；用户原 Clash 进程未操作 |

这是对节点出站 HTTPS 的单次检查，不是吞吐量/并发压测，也不证明 Codex 登录、原生中文或 TUN 已经通过验收。地域来自配置标签，未通过出口 IP 独立核验。源配置所有节点均设置 `skip-cert-verify: true`；探测保留该参数，不能宣称上游节点 TLS 证书验证通过。

可重复运行（路径为示例，不含真实节点）：

```powershell
node node_modules/typescript/bin/tsc -p tsconfig.electron.json
node scripts/probe-acceleration-nodes.cjs --config 'C:\运营配置\shared-upstreams.yaml' --core 'C:\运营工具\mihomo.exe' --report 'C:\运营报告\node-connectivity.json'
```

脚本不会自动下载、安装、替换内核。客户发行版还需要固定版本、来源校验、打包和 Windows/macOS 平台测试，不能依赖客户安装 Clash。

### 账号 20 分钟额度的服务端边界

这份配置共用一个长期密码。直接下发给客户端，即使后台记录了 20 分钟，也无法阻止客户端保留密码继续连；仅给客户端接口加短租约不能解决上游认证问题。

正式接入取决于节点归属，尚待运营方明确：

1. 自建且可管理认证：在节点端为客户签发可过期/可吊销凭据，余额耗尽或租约失效时拒绝连接并断开已有连接。
2. 购买订阅且只有 YAML：配置留在可控服务端网关，由网关接收客户的短期认证，再使用这批上游。需要可部署网关和额度服务的主机/域名。

现有 Sub2API 的平台额度为 USD、订阅为自然时间有效期，proxy 表是 AI 上游代理；都不是客户端累计连接秒数服务。账号权益须在服务端以验证过的 realm + user ID 为身份，处理累计秒数、开始/停止幂等、并发设备、心跳/断线与强制到期。客户端提供的 `scope` 不能单独作为服务端鉴权依据。

新增配置与诊断自动化只使用虚构节点和本地 HTTP mock；上述真实探测由用户明确授权后单独运行，不加入 CI。

## 预览和测试

- 当前免费试用统一为每账号累计 **20 分钟（1200 秒）**，不每日重置；主进程契约、renderer 默认值、交互预览和原型一致。计时格式仍为 `HH:MM:SS`。
- 交互预览把旧版 `xingmang-acceleration-preview:<scope>` 的一小时剩余毫秒数转为已使用时长，写入 `xingmang-acceleration-preview:v2:<scope>` 的 `{ version: 2, usedMilliseconds }`，保留旧记录。新余额为 `max(0, 20 分钟 - 已使用时长)`：旧剩余 35 分钟表示已用 25 分钟，新额度为 0；旧剩余 55 分钟表示已用 5 分钟，新剩余 15 分钟。刷新或隔天打开均不重新赠送。该存储只服务带「交互预览」标记的 mock，不能作为客户权益或正式计费依据。
- 20 分钟调整验证：controller 与预览迁移共 23 项单测、游戏加速 8 项浏览器回归通过；renderer TypeScript 检查通过，原型重新生成并完成语法检查。浏览器覆盖 20 分钟初值、暂停/续用、重开保留、旧 35 分钟余量迁移后耗尽及停止失败重试。
- React 完整界面：`/src/renderer-v2/testing/app.html?accelerationPreview=1`，从侧栏进入游戏加速；这是标注「交互预览」的 mock 环境，不改变网络。
- 原型：`ui-spec/work/modules/99z-acceleration.js` / `.css`，通过现有构建脚本生成公开原型，`#acceleration` 直达。原型状态为纯演示，实际 renderer 使用独立有测试覆盖的 controller。
- 历史 1 小时原型的截图：`artifacts/acceleration/idle-light.png`、`active-light.png`、`idle-dark.png`。1280×820 下页面约 620px 高，完整显示，横向无溢出；活动演示 73 秒后剩余 `00:58:47`，本次/累计 `00:01:13`。
- 主进程服务、IPC/preload 和 controller 337 项测试通过；新增浏览器 5 项通过：暂停恢复/跨页/刷新保留、后台耗尽停止、不可用状态、启停失败重试、未登录入口。全套 `npm run test:v2` 174 项单测和 170 项浏览器测试全部通过；类型检查、编译及 `check:v2` 通过。原型渲染、启停、TUN 开关也经独立浏览器验证。测试使用隔离 mock，没有生产网络请求。

## 用户可见的操作规则

点击开始后先连接，成功才计时；停止后保留剩余。切页或缩到托盘不停止，退出软件停止。每账号累计 20 分钟，不每日重置。TUN 关闭时只覆盖读取系统代理的应用；开启后覆盖更多应用。服务未开通时不扣时，不显示伪造的 `00:20:00` 已领取余额。

## 下载专用线路（2026-09-22）

装 CLI / 下 Node 这条最需要加速的链路，以前必须用户先去加速页点「连接」才有效。现在软件会在下载前自己把内核拉起来一次：

- **只开本机回环端口，不写系统代理**（`startDownloadRoute` 不调用 `proxy.enable`），所以整机网络不变，加速页仍显示未连接，`AccelerationState` 与 IPC 契约一行未动。
- 主进程用独立的内存分区 session（`xingmang-download-acceleration`）承载下载流量并给它设回环代理，默认 session 不动；npm 子进程拿到的仍然只可能是回环代理（约束见 `electron/download-proxy.ts`）。
- 线路起来了就把安装源顺序归约成 official-first（同时跳过区域探测）；用户在设置里钉死的 `mirrorPolicy` 优先级更高。
- 用户自己正在加速时什么都不做；下载期间用户点「连接」会接管同一个内核（同线路不重起），会话停止时若仍有下载持有内核则保留内核。
- 起不来、超时（预算 12 秒）、端口非法一律退化成「没加速」，安装照常进行。
- 下载时长不计入免费的 20 分钟（`downloadRouteBillsFreeAllowance`），但额度仍是门槛：用完的账号不再起临时线路。
- 已知行为：内核在下载途中意外退出时，这次下载会失败而不是自动回退成直连。

## 打开 Codex 桌面端时自动连接（2026-09-22）

Codex 桌面端（ChatGPT 客户端）是另一个独立进程，不在本软件的网络栈里，它唯一能跟着走的是系统代理——所以上面那条「下载专用线路」对它毫无作用，用户不点「连接」时它就是直连的，界面语言也因此会回落成英文。从软件里点「打开」时，先替用户连一次：

- 走的是与用户亲手点「连接」**完全相同**的 `acceleration-service.startAcceleration`（模式固定 `system-proxy`，不指定线路），所以会话、免费时长计时、加速页上的已连接状态一并照旧。
- 已经 `active` / `connecting` / `stopping` 的一律不动：那条线路归用户，不替他重连或改线。
- `unavailable`（本机组件起不来）、`exhausted`（免费时长用完）、未登录、读不到状态一律跳过，桌面端照常打开。
- 后端在检测到其他代理或 VPN 时会拒绝连接并返回未连上的状态，这里同样按「跳过」处理，不替用户忽略冲突。
- 预算 15 秒；超时、失败、拒绝全部收敛成一句日志（`acceleration.codex-desktop.*`），`ensureConnected` 永不抛错——加速是加分项，不能变成「打开」的前置条件。
- 连上之后**不自动断开**，由用户在加速页自行停止。
