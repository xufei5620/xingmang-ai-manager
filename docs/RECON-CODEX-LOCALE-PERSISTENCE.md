# Codex 中文重启保持机制复核与修复候选

研究日期：2026-10-04。问题：首次通过星芒打开 ChatGPT/Codex 并设中文后，退出星芒、关闭桌面端甚至重启电脑，再直接打开官方客户端，中文是否保持，是否有稳定解决办法。

本文是前置只读研究，随功能开关审计 PR 提供机制证据，不修改用户语言、统计设置、缓存、官方安装包或系统代理，也不改现有插件方案 PR。当前整体结论和整改顺序见 [功能影响审计](MANAGED-FEATURE-EFFECTS-AUDIT.md)。截图下半部分的安装取消问题不属于本次范围。

## 先用普通话说明结论

中文翻译文件已经在官方软件里，用户选的“简体中文”也能保存。另有一个“是否启用翻译”的功能开关；即使中文偏好还在，这个开关读不到时，主界面仍可能显示英文。

星芒为了减少命令行退出时等待统计请求，默认在 Codex 共用配置里关闭使用统计。当前桌面版本恰好把使用统计与功能开关的本地缓存绑在一起：关闭统计，也关闭持久缓存。这会让第一次联网取得的中文开关只活在当前进程中，下次网络不可用时就没有旧值可读。

因此，截图中“直接打开就多半英文”的现象有真实机制支撑，但“每一次都必须联网拿开关”说得太绝对。存储开启且真正保存过正常初始化结果时，离线重启可以继续读到中文开关。

优先修复方向是拆开星芒对 CLI 和桌面端的配置影响，尊重用户自己的统计选择，再验证原生缓存能否保持。不能简单把所有客户的统计改成开启，也不能承诺一次联网后永久中文。坚持关闭统计、原生未保存缓存、账号/身份变化或官方返回关闭时，仍需要可靠启动辅助或官方上游修复。

## 1. 本次基线与范围

| 证据 | 基线 |
| --- | --- |
| 官方 Windows 安装包 | OpenAI.Codex 26.930.3930.0 |
| 应用内部版本 | 26.930.31730，build 12947 |
| 内置 Statsig SDK | 3.34.0 |
| 星芒最新源码核对 | GitHub API 固定 main 为 8654bb04bd3b5f349a50d2be54efeeac18935f1a |
| 本地工作区 | 旧 HEAD 1eee5f0f；git fetch 两次失败，因此最新关键文件通过 GitHub API 读取，未把本地文件称为最新版 |

研究对象是当前承载 Codex 功能的官方桌面应用。Windows 安装包静态逻辑、SDK 实验与 Mac 实机结果分别记账；本次没有 Mac 设备上的冷启动证据。

当时仅核对本机非敏感的语言/统计白名单字段作为对照，没有读取 auth.json、Cookie 或密钥。该状态不代表截图中客户机器，未用它认定客户已经命中同一原因。

当前研究 PR 进一步复核了 e97392ab 基线；上述两个源码基线的 config-files.ts、codex-desktop-cdp.ts 无文件差异。SDK 机制实验仍限定该官方安装包版本。

截图引用的 Page 未能在当前连接中定位；本文依据截图、仓库源码、实际官方安装包和隔离实验重新核实，不把截图文字当已完成的真机验证。

## 2. 偏好、翻译消息与菜单是三条路径

官方 `app-initial-74dc12f48352.js` 的 `gZs`：

- localeOverride 存在时最高优先；没有显式设置才参考 IDE/系统语言。
- 单独读取动态配置 72216192 的 enable_i18n，缺省 false。
- 开关关闭时，IntlProvider 的 messages 为 undefined，即使解析出的语言和 document.lang 已是 zh-CN，也会使用默认英文消息。
- 中文消息通过本地动态 import 读取 `zh-CN-3ed9eb1db28a.js`；本机这个资源为 2,397,171 bytes，已经在 app.asar 里。
- 消息文件读取失败还有独立的 Failed to load locale messages 与英文回退，不能把所有英文都归因于开关。

`general-settings-fb3be54dc572.js` 的 `Ks` 语言选择器读取同一开关，却使用缺省 true；选择语言仅写 localeOverride。故某些缺值情形下，用户可以看见语言选项并保存中文，但主界面翻译仍不开启。

原生菜单由主进程读取 localeOverride，再从随包 native-menu-locales 读取本地 JSON；这条路径没有上述 enable_i18n 判断。因此可能出现菜单中文、主界面英文，不能把菜单成功当作整个界面已经中文。

仅设置操作系统中文、localeOverride 或启动参数 --lang，均不能单独保证跨过主界面的翻译开关。

## 3. 统计设置为什么影响缓存

已核对真实数据链，而非仅根据函数名称推断：

```text
本地主机 config/read
  → config.analytics?.enabled !== false
  → 官方 Statsig 初始化 DIs(value)
  → value===true：允许默认存储与统计
  → 其他值：disableStorage=true，loggingEnabled=disabled
```

配置缺省时宿主将 analytics 判为 true；显式 false 为 false；配置读取失败而 data 为 undefined，也会走关闭存储分支。与此同时 preventAllNetworkTraffic 为 false：关闭统计仍会请求功能开关，只是不能持久保存。

SDK 自身可以把日志和存储分别配置，但本版本桌面宿主没有暴露“关闭统计、仍保留功能缓存”的独立用户配置项。官方配置文档将 analytics.enabled 定义为使用统计设置，不是语言设置。[官方配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)

同一进程会复用已经构造的 Statsig client，未找到宿主调用 updateRuntimeOptions 即时改变存储模式。修改统计设置后需要彻底退出并冷启动验证，不能只观察当前窗口。

## 4. 星芒当前实现如何命中这条链

最新固定源码 `electron/config-files.ts`：

- disableCodexRelayAnalytics 在 analytics.enabled 未定义时补 false。
- 新生成的中转配置模板直接写入 `[analytics] enabled = false`。
- 合并中转配置、补齐中转模板默认值同样经过此逻辑。
- 已有注释将关闭统计描述为没有功能损失；对本次检查的官方桌面版本，这个描述不完整，因为它会影响功能开关缓存。

这项默认原本是为避免 CLI 退出等待 ab.chatgpt.com 的统计请求，属于实际的性能动机；不能为了语言把整项无差别删除或反过来强制开启统计。[固定星芒实现](https://github.com/xufei5620/xingmang-ai-manager/blob/8654bb04bd3b5f349a50d2be54efeeac18935f1a/electron/config-files.ts#L949)

切回官方账号也不能一概说会删除 false：有官方配置快照时会原样恢复快照；没有快照走 strip 流程时，restoreCodexAnalytics 只删除恰好只有 enabled=false 的 analytics 表。

中文运行时补丁是另一件事。Windows 只有从星芒启动、且此前明确选择启用时才带调试端口并执行 CDP 补丁；补丁改变当前进程对象，不是写入官方程序文件。直接从官方入口新开的进程不会自动继承。Mac 当前主进程不走这个 CDP 补丁，只写偏好并使用启动网络辅助。[现有启动与设置模块](https://github.com/xufei5620/xingmang-ai-manager/blob/8654bb04bd3b5f349a50d2be54efeeac18935f1a/electron/system-service.ts)

## 5. 16 项隔离 SDK 实验

从本机安装包提取原 SDK 模块，用新的 Node VM 模拟每次启动，按场景共享模拟 localStorage。全部用户 ID、开关响应均为夹具；global fetch 禁用，网络由内存响应或模拟失败替代。没有启动真实桌面窗口或修改真实 Chromium 存储。

| 场景 | 启动后开关 | 来源 |
| --- | --- | --- |
| 存储开启，第一次初始化返回 true | true | Network |
| 同身份新 VM，网络失败 | true | Cache |
| 缓存接收时间人为改为 366 天前，网络失败 | true | Cache |
| 已有同一缓存，但当前关闭存储 | false | NoValues |
| 只换 app session/version，身份不变 | true | Cache，附 PartialUserMatch |
| 换 user ID | false | NoValues |
| 换 account ID | false | NoValues |
| 换 stable ID | false | NoValues |
| 官方明确返回 false | false | Network，新值覆盖旧值 |
| 上一步后离线启动 | false | Cache |
| ChatGPT post-login bootstrap 单独返回 true | true | Bootstrap，未写 evaluations 缓存 |
| bootstrap-only 后新 VM，网络失败 | false | NoValues |
| ChatGPT 身份正常 initialize 返回 true | true | Network，写入缓存 |
| 上一步后新 VM，网络失败 | true | Cache |
| 存储关闭，第一次网络返回 true | true | 内存；持久存储空 |
| 上一步后新 VM，网络失败 | false | NoValues；持久存储空 |

主代理独立断言了其中 13 个关键场景的开关值／provider，以及“禁存储不落盘”“正常 initialize 缓存可离线复用”“bootstrap-only 不写缓存”四项结构条件。其余记录保留完整观察值。

当前 SDK 的评估缓存校验未发现固定 TTL；它会受身份键、存储可用性、条目淘汰和新响应影响。366 天实验不能外推为永久保留保证。实时自动刷新写入的 live overlay 同样不能直接当作已经持久化。

补充反查了两处真实界面消费者：gate 459748632 经 renderer 的 multiWindow 状态传给主进程，默认 false 时不加入 File 菜单的 New Window 项；gate 1848317837 默认 false 时不处理一条 open-pet-install-modal 弹窗路径。这说明缓存副作用范围超过中文，但只有在缺少有效网络值/缓存/覆盖时才可能表现出来，不等于所有开窗或宠物能力都关闭，也没有证明客户原本拥有这些开关。

这证明的是 SDK 缓存行为和应用参数链，不是客户现场或 Mac 重启后的视觉结果。

## 6. 解决方案比较

| 方向 | 作用 | 结论 |
| --- | --- | --- |
| 修正 CLI 对桌面公共配置的影响 | 保留用户自己的桌面统计选择，把 CLI 等待优化局限在 CLI 调用 | 优先验证的产品修复候选，改善当前中转默认引发的缓存问题 |
| 首次正常取得官方开关，保留同身份原生缓存 | 网络暂时失败时仍可中文 | 条件性有效，不覆盖明确关闭、换身份、被清理或 bootstrap-only |
| 星芒提供明确的中文启动入口 | 后台完成偏好、短时网络准备；Windows 按既有 opt-in 使用兼容补丁 | 可保障受管理入口的流程，不能声称所有官方入口都已覆盖 |
| 检测原生进程后再临时介入 | 尝试覆盖用户直接开原图标 | 存在初始化竞态，已启动进程无法追加启动参数，不能作为确定保障 |
| 官方上游解绑显式语言与远程门控/统计缓存 | 用户选择中文后直接使用已内置翻译 | 最彻底、最稳定的长期方向；需官方客户端提供，星芒不能靠虚构设置实现 |
| 修改官方 app.asar、伪造服务端开关或移植他人缓存 | 改变内部行为 | 不选为客户产品路线；破坏升级/签名/身份边界，且难保证 Mac 与新版本 |

### 优先候选的具体改法

1. 保留并正确回读 localeOverride；增加界面与原生菜单的分别诊断，不把“配置是中文”直接显示为“界面已中文”。
2. 将 CLI 统计等待优化从共享的全局配置迁到星芒可控制的 CLI 临时命令参数；优先复用 `cliLaunchArgv()` 的全局参数位置，内部扩展管理的两个 invoker 单独覆盖。参数需放在子命令之前，不能放到 MCP 的 `--` 之后。桌面端沿用用户自己的统计选择；CLI 也不能无条件覆盖用户明确写的 true。专用 profile 的 analytics 支持尚未验证，不作为已知可用实现；不复制一整套 CODEX_HOME 导致账号、会话分裂。
3. 新安装不再为 CLI 性能自动覆盖桌面公共选择。旧安装迁移必须有可靠的星芒写入归属记录；仅凭文件中 enabled=false 不能区分是用户选择还是旧模板，不能静默删除或改 true。
4. 对用户主动关闭统计的机器，保持选择，清楚说明这个官方版本的缓存限制。需要更强中文保持时使用可说明的启动辅助；不能以“修中文”为由开启数据统计。
5. 只有在同一身份下确认正常 initialize 已把允许开关保存在原生存储，再测试直接从官方入口冷启动，才能说这一路在目标版本有效。不能只验证从星芒打开一次。

本候选仍需性能、隐私默认、直接 CLI 启动和 UI 重启 A/B 验证。它可能大幅改善中转用户体验，但不是“永久中文”承诺。

外部终端、IDE 和用户脚本直接运行的 Codex 不经过星芒临时参数，原有统计退出等待可能仍出现；本修复不借机改全局 shim 或用户脚本。旧 relay/官方快照的迁移也必须分别保留用户选择，不能只处理当前活动文件后又在切账号时恢复旧默认。

## 7. Windows 与 Mac 分别验收

共同检查：中文偏好、有效 analytics 值、实际 CODEX_HOME 与桌面 userData、应用版本、初始化来源、同身份是否命中缓存。可记录状态和摘要，不能导出整个 Statsig 响应或身份信息。

Windows：从星芒启动与从原生桌面/开始菜单/任务栏分别启动；关闭主窗口与彻底退出进程分别测试；新用户、原有缓存、关闭统计、不同用户 root、系统重启、应用升级都需要覆盖。

Mac：本次只知道星芒写配置与启动代码，不能把 Windows 安装包的 SDK 实验叫作 Mac 已通过。必须取得目标 Mac 包，核对相同语言/缓存逻辑；Apple Silicon 与 Intel 分别从 Finder、Dock、Spotlight 冷启动。Command+Q 与只关窗口不同；现有 `/usr/bin/open --env CODEX_HOME=…` 不会改已经运行的应用环境，也不能证明之后从 Dock 仍继承非默认 root。

单改一个快捷方式只能覆盖那个入口。Mac 的原 .app、Finder/Spotlight 与 Windows Store/任务栏不自动受星芒启动器控制；若使用新的“中文启动”入口，应让用户清楚知道，不能把它当作对原生任意入口的保证。

## 8. 下一步最有价值的验证

在隔离测试用户中，保持同一官方客户端版本、同一身份与中文偏好，比较以下路径：

1. 当前星芒默认：共享 analytics=false，首次官方 initialize true → 完全退出 → 官方原入口离线冷启动。
2. 候选配置隔离：桌面保留测试用户明确选择的官方默认，CLI 单独关闭统计 → initialize 成功 → 完全退出星芒/桌面 → 官方原入口离线冷启动。
3. 继续尊重 analytics=false 的用户：由受管理入口提供网络初始化／已同意的兼容路径，验证成功与失败都能准确报告。
4. ChatGPT bootstrap-only、账号切换、配置读取失败、缓存不可写、官方明确 false、消息资源损坏分别测试，避免把多个原因都报“中文设置丢了”。

第二条通过后再改星芒默认策略；正式上架之前需 Win/Mac 真实窗口结果，且验证 CLI 等待问题没有重新扩散。向官方反馈“明确选中文却因统计开关失去持久语言状态”也有具体源码和隔离复现材料，但本次没有向外部发消息或提交 Issue。

## 9. 证据定位

本机安装包静态指针（版本限定）：

- app-initial-74dc12f48352.js：gZs 约 9369590；DIs 约 9059966；xIs 约 9052218；CIs 约 9055188。
- app-shared-2d992d47c83d.js：rSn/iSn 约 3434863/3435240；SY 约 3435911；DataAdapterCore 约 2122800；SDK version 3.34.0。
- general-settings-fb3be54dc572.js：Ks 约 126311。
- main-C_jM0dPl.js 与 startup-requirements-BXJhIMRW.js：原生菜单初始化及 localeOverride 监听。

不同提取工具按 Unicode 字符、UTF-16 或 UTF-8 字节计算的偏移不完全相同，应以函数和字符串锚点定位；独立 evidence 文件保留了对应字符及 UTF-8 字节偏移。

完整 SDK 实验在本次研究材料目录；结果和关键源码证据另存于 `20261004-codex-chinese-persistence`。本研究没有将官方 JS 或真实用户缓存加入仓库，没有修改或提交功能代码。
