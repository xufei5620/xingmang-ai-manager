> 统一审查报告的专项附件；固定源码基线为 c21be274，后续新增提交见 [最新增量复核](../latest-delta.md)。本页中的本地证据名称用于维护者对账，关键观察结果已在正文给出；完整受控材料不公开。

# Core 只读复核与修复方案

基线：c21be2741af6674b2f422d9891b57fc3d2ba5b7b。范围以 core-inventory.json 的 378 个文件为准；本文件与 core.md 合并阅读。报告日期 2026-10-28。

## 证据口径

- 每文件 SHA256 对照本轮 inventory。旧源码一致时复用 ffc04922 的逐段阅读记录，并明确标 reuse-full；不声称本轮重新逐行读完约 12.7 万行。
- IPC 五个差异文件使用“旧全文 + 本轮完整差异”复核，新增的是 Mac 桌面更新参数及固定 App 管理设置入口。契约、preload、注册、日志策略一致，request 经白名单解析，不接受路径。
- 测试文件逐文件检查结构、场景与关键断言，未完整细读的标 fresh-targeted-tests；AST 提取不是全文阅读、不是执行通过。原测试全文与断言结构见 core-test-structure.json。全套 typecheck/npm test 由主审统一执行，结果须引用主审日志。
- 本轮 fresh 原模块证明：core-current-proof.cjs / core-current-proof.json / core-current-proof.log；退出码 0，外部进程/网络调用 0。只在本审计目录创建临时配置与文件，没有修改产品源码或真实用户数据。
- 全文读过 fixture 生成器，重新生成到 core-generated-fixtures 后三份 JSON 的 SHA256 与当前源文件一致。巨大重复坐标与文本不是逐字符人工阅读，标 fresh-generated-data。

## 原问题当前结论

### O01：MCP 参数密钥进入日志——原触发场景仍已修复

当前 command-runner.ts:936 附近收集 argv 的敏感值；redaction-patterns.ts:154 附近识别名称与后一项值的配对。两文件 SHA256 与前轮完整阅读快照相同；原 --access-token VALUE 故障复现的错误对象、运行日志、反馈报告均不含假密钥，复用该结果。本轮没有重新执行外部 MCP 命令。

证据：本地证据/evidence-ba916647.json；本轮 coverage 的 command-runner/redaction-patterns 哈希。原安全底座既有测试日志是历史执行，不作本轮 fresh 计数。

方案：保留当前修复；后续改参数脱敏时保留 “--access-token VALUE / --access-token=VALUE / 错误 cause / stdout-stderr / 反馈导出” 的负向断言。不得因已经修复而删掉配对收集。

### O11 / P2：保存与失败回滚仍会覆盖其他程序的新配置

**状态：仍存在；当前 fresh 复现。** 用户在星芒保存时，另一个程序也保存配置：星芒会覆盖它；第二文件失败后的回滚也会覆盖其新内容；若该文件最初不存在，回滚会删掉别人刚写入的文件。

位置：electron/config-files-context.ts:328–353 仅记录是否存在及备份路径；:439–452 提交前仅核对路径安全；:356–395 回滚无内容归属比较。正常保存由 config-save-service.ts:928 传入正常 hooks；上层开始前检查不能覆盖事务中间发生的改写。

当前证据 core-current-proof.json：
- save：外部写 external 后最终变 manager，没有冲突错误。
- rollback-existing：第二项失败前外部写 external，最终变 old。
- rollback-new：外部写 external，失败回滚后文件不存在。
- control：无竞争正常提交 manager。
这使用真实 executeFilePlans 与临时文件，hook 只控制外部写入时点；没有进程间实际并发时间概率声明。现有 config-files.test.ts:1808–1957 覆盖失败回滚及文件占用重试，未覆盖保留并发的新内容。

**具体方案：**
1. FilePlan/PreparedFilePlan 增加规划时的存在性及内容摘要/身份快照；提交与每次占用重试前复核，变化则停止并提示“配置已被其他程序修改，请重新读取后保存”。
2. 记录本事务实际提交后的文件身份与摘要。回滚只恢复仍与本事务提交结果一致的目标；原不存在文件也仅在仍是本次新文件时删除。
3. 遇到外部修改，保留它和原备份，返回明确的冲突/部分恢复结果；不能为了凑完整回滚再次覆盖外部内容。
4. 保留现有 reparse/单链接检查、durable 临时文件和备份轮换；本机保存队列不能代替与外部程序的冲突判断。

**验收：** 上述三反例都保留 external 并报告冲突；无冲突保存/回滚通过；占用重试时外部改写同样拦住；新增文件与删除计划均覆盖；已有多文件故障恢复、链接拒绝用例继续通过。

### D04 / P2：切 API Key 时仍保留强制 ChatGPT 登录

**状态：仍存在；当前 fresh 保存/检查对照，CLI 行为证据 reuse。**

前提是用户级 Codex config.toml 已有合法 forced_login_method="chatgpt"，之后通过正常默认 merge 保存星芒 Key。config-files.ts:996–1033 的 applyCodexRelayConfig 没有协调该设置；:1153–1171 保留它；同时写 API Key auth。:1535–1606 的检查仍显示 matchesRelay=true、hasApiKey=true、authMode=apikey。

core-current-proof.json 复现 merge 保留 chatgpt、检查显示可用；reset 对照清除该限制。前轮真实 createConfigSaveService 也返回成功、取消官方标记；旧隔离 Codex CLI 0.157.1 确认拒绝这种组合、删除 auth.json 并退出，0 个网络请求。这个 CLI 版本与行为是历史证据，**本轮没有运行 CLI，也没有验证最新推荐版本运行表现**。

历史证据：本地证据/config-forced-login-repro.log 及 config-extra-review.md。

**具体方案：** 对用户明确选择 API Key 的保存/切换，在用户级活动配置中将 forced_login_method 与 apikey 对齐（或移除会冲突的用户项），把官方配置原值留在官方快照供切回；如果限制来自不可改的策略层，则在写入前阻断并解释原因，不能保存成功后才发现冲突。inspectProviderConfig/连接检查需要将生效登录要求纳入可用性判断，不能只看 Key/URL。不应顺手清除无关用户配置或强改项目/企业策略。

**验收：** merge、存有 relay snapshot、官方到星芒、再切回官方四条路径；原强制 apikey 和未设置对照；不可修改策略时 0 文件变更；保留官方原值；成功结果真实可用于 API Key 登录。厂商 CLI 验收需独立离线替身或明确版本的隔离环境，不能发生产请求。

### D12 / P2：配置不可读时诊断已完成，但导出和反馈自检段失败

**状态：仍存在；关键源码本轮复核，完整反例 reuse。**

electron/bootstrap/diagnostics.ts:118–120 逐工具无隔离读取 apiKey；:224–229 导出同步调用它；:285–294 反馈也使用它。任一工具配置安全拒绝/读取错误，会让已存在的诊断报告导不出来，反馈报告的“最近一次自检”整段退成“未能读取”。运行诊断本身在 diagnostics-context.ts:264–272、diagnostics.ts:442–465 可以容纳单项错误。

上述相关文件 SHA256 与旧 ffc04922 证明相同。旧原模块临时硬链接反例：29 项诊断形成，Codex 项 error；导出失败、自检反馈丢段；移除测试额外链接后不重跑诊断，同一报告导出 7,934 字。该输入用于触发正确的安全拒绝，不能把安全拒绝本身作为漏洞。权限等错误沿同一抛错分支，但没有将未实测的所有权限场景算作已经复现。

历史证据：本地证据/diagnostics-export-unreadable-config-repro.log、security-diagnostics-extra-review.md。

**具体方案：** 敏感值采集按工具隔离失败，使用本轮诊断已经安全采集的 Key 集合补充脱敏；未读项记录“未能读取”，其原始配置内容不进入报告。报告继续采用敏感形状脱敏/结构字段过滤，保存已成功取得的检查项。不放宽链接校验，不为凑报告读取危险目标。

**验收：** 一家不可读、其他家正常时可导出且保留全部检查结果；正常 Key 与各种敏感字段在报告中均不可见；反馈自检不整体丢失；恢复可读后结果正常；无报告时原提示不变。现有 bootstrap/diagnostics.test.ts 只覆盖无报告、账号不一致拒绝与 describer 接线，不覆盖此失败链。

### D14 / P2：会话导出写入错误仍会升级到未捕获异常

**状态：仍存在；当前 fresh 反例 + 正常对照。**

electron/session-markdown-export.ts:65–68 的 writeChunk 只处理 write 回调错误；:71–75 到 endStream 才监听 error；:90 创建流后开始写。Node Writable 在写失败时还发独立 error 事件，拒绝 Promise 并不能接住这个事件。

core-current-proof.json 用真实 exportSessionMarkdown，模拟 ENOSPC 流写入失败，观察到 Promise 拒绝 **以及 1 次 uncaughtException**；正常真实临时文件导出成功。审计 harness 捕获了未捕获事件以保存证据，产品 main 的异常处理会退出/按条件重启，主启动接线由 helper 复核。现有 session-markdown-export.test.ts:73 的失败用例是“读取消息失败”，不是“写出流失败”，所以原测试通过不能证明这项已修好。

**具体方案：** 创建流后立即建立贯穿整个生命周期的 error/close 处理（可用 stream/promises.finished 或同等一次性状态管理）；所有 write/end 共用该失败状态，防重复拒绝/悬挂。流真正完成后再原子改名；失败关闭句柄、删除临时文件、保留已有目标，再只向 IPC 返回中文可恢复错误。

**验收：** 第一块写、后续块写、end/close 各阶段注入 ENOSPC/EIO，捕获到 0 次未处理 error、0 次 unhandledRejection；导出 Promise 明确失败，旧文件字节不变、临时文件不遗留；正常导出/截断提示/读源失败/覆盖已有文件均通过。

### 第二轮 B2-1 / P3：坏备份界面隐藏——主进程继续保留错误记录

本项全链状态由 renderer owner 合并。当前 fresh 原 ConfigBackupStore + registerBackupHandlers 证明：正常返回 1 项 valid=true；将本临时 manifest 截断后返回 1 项 valid=false、provider=null、错误“备份清单不是有效 JSON”，磁盘目录仍在。位置 backups.ts:642–664、ipc/handlers/backups.ts:11–12。后台没有丢记录，也没有删除备份。

旧浏览器证据见 本地证据/backups-visibility-result.json。renderer BackupCard 应只过滤明确退休工具，未知 provider 的 invalid 项保留在“全部工具”，显示错误、禁止恢复、允许删除；不能写成坏清单仍可安全恢复。验收应同一真实 handler 数据验证正常行、坏行、删除入口与明确退休工具仍隐藏。

## 本组未新增为问题的观察

- syncXingmangAiSkill 的若干局部 await 旁没有独立账号 epoch，不单独报串号：正式入口 account:sync-managed-cli-keys 在 ipc.ts:354–357 由 accountWork scoped 包裹，账号切换等待工作结束。只看 helper 的局部代码会误报。
- 新增桌面更新解析只接受 update=true 与 boolean closeRunning，固定设置入口没有 renderer 提供 URL/path 的能力。ipc.test.ts:3356–3381 已有合法/恶意额外字段、非信任 sender 和非 Mac 回退的断言，本轮核过源码；执行结果使用主审统一测试。
- Skill 默认图像 MCP 授权、已退休 Gemini 的保留代码、官方快照保留行为均为明确设计边界，不当作新漏洞。
- 不对没有可达后果证据的理论文件替换窗口、秘密跨 chunk、用户可编辑配置设计作确定漏洞判断。

## 跨 owner 旧项

O10 的根因在 codex-extensions.ts；O17 见安全摘要，D13 在 codex-sessions.ts，归 install 组；D26 根因 balance-alerts.ts 丢站点，归 accounts；D27 根因 renderer recent-workspaces。core 的相邻调用文件已审，但这些条目由根因 owner 给最终当前结论，不重复计数。O12/D18/D19 的底层卸载、PATH、平台 Grok 分支同理由安装/平台组给结论。

## N5 / P2：点击启动后才捕获账号，目录检查期间切账号仍串到新账号

**状态：仍存在；本轮 fresh 接线复核 + reuse 原动态/界面证据。** 在 A 账号点打开，目录可写性检查未完成时切到 B，旧请求随后会按 B 的配置打开。这里不声称已经发生真实扣费。

当前 ipc/handlers/launch.ts:244–257 接收请求时不捕获账号；:329 await inspectWorkspaceWritable；:334 再调用 launchProviderWith；:228–230 才 accountWork.queue()。ipc.ts:355–357 明确不对 scoped-queued 再包全程保护。provider-launch-service.ts 的队列内保护能拒绝“捕获后”的变化，却不能发现“捕获前”已经换了账号。因此现有 system-service.test.ts:6972–6989 不能覆盖原反例。

根因文件 SHA256 与 ffc04922 相同。历史真实 IPC/账号门闩/安装队列/启动服务/配置读取组合证明读取 B，正常对照读取 A；浏览器证明等待期间正常界面允许切账号。复用 本地证据/renderer-launch-main-evidence.json、renderer-launch-ui-evidence.json，没有本轮重复运行或真实 CLI。

**具体方案：** 在 cli:launch handler 同步入口捕获账号/site/revision 的不持锁快照，贯穿 resume 查询、敏感目录确认、可写性检查、换目录及进入安装队列；每个等待结束、真正启动前均核对同一快照，变化则取消并要求用户在当前账号重新点开。不要为修复而在漫长目录对话框/安装排队期间阻塞用户切账号。

**验收：** 普通目录检查、敏感目录对话框、续聊查询、换目录等待期间分别 A→B 和跨站同 userId：旧请求都不启动；A 未改变仍正常启动；排队后切账号原保护继续有效；取消/重复点击释放工作记录，不产生门闩泄漏。


完整 ../coverage.md 已合并 378 路径并重新核验 SHA256，0 差异、0 pending。覆盖分类：176 reuse-full、8 旧全文加本轮完整差异、21 fresh-full、2 生成数据核验、171 targeted-tests。targeted-tests 不等于逐行审完测试源码。生命周期子组详细报告如下。


---

# 核心生命周期与系统辅助专项复核

基线：`c21be2741af6674b2f422d9891b57fc3d2ba5b7b`。固定源码基线。独占范围为 `core-helper-inventory.json` 的 121 个文件。产品源码和真实系统只读，产物仅在本报告目录。

**本分片确认 1 项新增 P2；旧 D15 在当前代码离线重新复现，旧 #7 的启动安装保护遗漏仍可从当前接线确认。** 未执行真实安装、卸载、CLI、关机、Electron 窗口或生产请求。此结论不代表全项目审计结束，也不代表全部测试通过。

## 新增 U05 / P2：托盘释放后的页面恢复失败，后续打开窗口不再重试

**触发**：主窗口隐藏到托盘且空闲，被释放以节省内存；再次打开时，本次 `loadURL` 因临时的本地页面加载故障拒绝，未收到 renderer 的活动/就绪上报。条件是这一次恢复失败，不是每次从托盘打开都会发生。

**影响**：控制器永久停留在 `restoring`。再点托盘/桌面入口、让窗口重新 show/focus，都不会重新加载；原有崩溃重开兜底也被拦住，待发的导航/打开工具事件一直不交付。当前可用的恢复方式可能只剩重启整个管理工具。没有证明正常加载路径也受影响。

**精确代码**：

- [renderer-release.ts:156](https://github.com/xufei5620/xingmang-ai-manager/blob/c21be2741af6674b2f422d9891b57fc3d2ba5b7b/electron/renderer-release.ts#L156)：`restore` 在 158 行对 `restoring` 永久返回 true；160 行先置为 `restoring`，166 行即便同步 reload 抛错也只记录，不撤销状态。
- [main.ts:2777](https://github.com/xufei5620/xingmang-ai-manager/blob/c21be2741af6674b2f422d9891b57fc3d2ba5b7b/electron/main.ts#L2777)：实际 `loadURL(...).catch(...)` 只写日志，没有把异步失败交还控制器。
- [main.ts:577](https://github.com/xufei5620/xingmang-ai-manager/blob/c21be2741af6674b2f422d9891b57fc3d2ba5b7b/electron/main.ts#L577)：`reloadIfRendererGone` 在 580 行看到 `restore('show') === true` 便返回，因此 581 行 crash recovery 无机会恢复。
- [renderer-release.ts:193](https://github.com/xufei5620/xingmang-ai-manager/blob/c21be2741af6674b2f422d9891b57fc3d2ba5b7b/electron/renderer-release.ts#L193)：只有成功 renderer 的 `reportActivity` 才把状态退回 `live` 并放行待发事件。

**当前离线证据（fresh）**：`core-helper-repro.cjs` 转译当前 `renderer-release.ts`，并从当前 `main.ts` AST 提取真实 reload 回调与真实 `reloadIfRendererGone`，替换窗口/加载边界。第一次加载注入拒绝，之后 3 次重新打开，结果 `loadCalls=1`、`crashRetryCalls=0`、`state=restoring`、`queuedEventDeliveries=0`。成功加载并上报的对照变为 `live`，待发事件交付 1 次。结果见 `core-helper-repro-results.json`（本地受控证据）。没有启动 Electron 或制造真实磁盘故障。

**现有测试缺口**：[renderer-release.test.ts:172](https://github.com/xufei5620/xingmang-ai-manager/blob/c21be2741af6674b2f422d9891b57fc3d2ba5b7b/electron/renderer-release.test.ts#L172) 验证“恢复期间不重复加载”；232 行验证的是 `hiddenInTray` 回调抛错，没有覆盖恢复加载拒绝后的再打开。完整阅读了此测试文件；没有把现有通过结果当成该反例已被覆盖。

**具体修复**：让恢复动作接收异步加载结果（例如 `reload(): Promise<void>` 或显式 `reportRestoreFailed`），以每次恢复的 token 区分过期结果。当前恢复失败时退回可重试状态，保留待发事件；下一次用户打开只发起一次加载。可加有界就绪超时，但不要把慢加载当成无条件无限重试，也不要提前把未就绪 renderer 标为 live。

**验收**：第一次 reload 拒绝后第二次打开实际重新调用 loadURL；第二次成功上报后 pending 事件恰好交付一次；慢但成功的恢复仍合并重复 show/focus；旧恢复迟到失败不能清掉新恢复状态；dispose 后不再重试/交付。补一个跨 `main` 回调与控制器的断言，避免只修同步异常分支。

## 旧问题的当前状态与边界

| 旧 ID | 本分片结论 | 当前/历史证据与后续归属 |
|---|---|---|
| #7 启动自动更新打断工作 | **仍存在：fresh 静态接线 + reuse 历史动态证据** | `main.ts:1559`、`:1619` 两次 busy 仍只读安装队列；`:1602` 直接 install。`:2514-2528` 的视频、rendererBusy、遥控、付款保护只在另一条 prompter 路径。旧复现 `xingmang-reaudit-20261027-ba916647/update-repro-results.json` 不是本次重跑。 |
| #12 提权 npm 卸载丢 prefix | 本分片未重新判定根因 | 根因 `tool-installation.ts` / `cli-uninstall-service.ts` 不在独占清单；历史 `install-config-evidence/repro-results.json` 保留原结论，由安装 owner 对当前文件核对。 |
| N5 启动跨账号 | 本分片验证队列内保护存在，不能据此判已修 | 当前 `provider-launch-service.ts:656-673` 使用 `accountWork.run` 与 signal；`system-service.test.ts:6972-6989` 只覆盖已捕获 work 被取消。历史反例是 IPC 目录检查后才捕获身份；`ipc/handlers/launch.ts` 不在清单，交 IPC owner 核对。 |
| D15 取消关机后退出标志不复原 | **仍存在：fresh 动态复现** | 当前 `window-lifecycle.ts:334-343` 置 `systemShutdown` 没有复原；`:226-244` 读取后直接退出。下面详细列出。 |
| D17 自定义 HOME 后 Grok 不能卸载 | 当前扫描/环境侧仍匹配旧根因；安装/卸载侧由 owner 合并 | `system-scan-service.ts:996` 仍优先 `cliEnvironment.HOME`；`provider-launch-service.ts:148-160` 对 Grok 不归一 HOME。历史临时安装对照 `grok-home-mismatch-results.json` 沿用，非本次重跑。 |
| D18 Windows Grok 首装未补用户 PATH | 当前扫描端仍调用通用 sweep，根因分支交 owner | `system-scan-service.ts:1379-1384`；历史 `grok-home-mismatch-results.json` 记载 PATH 写入次数为 0。`windows-cli-shell-access.ts` 和安装分支不在清单，本分片不冒称重新验证了它们。 |
| D19 Mac/Linux Grok agent 指向旧版本 | 本分片未重新判定根因 | `macos-grok.ts` / `linux-grok.ts` 不在清单；沿用历史 `platforms-behavior-result.json` 作为待对应 owner 刷新证据。 |

### D15 的精确复核、修复与验收

当前 [window-lifecycle.ts:334](https://github.com/xufei5620/xingmang-ai-manager/blob/c21be2741af6674b2f422d9891b57fc3d2ba5b7b/electron/window-lifecycle.ts#L334) 在 `query-session-end` 设置 `systemShutdown=true`；没有 `session-end`、程序继续运行时也不清除。后续正常 `requestQuit` 进入 [window-lifecycle.ts:226](https://github.com/xufei5620/xingmang-ai-manager/blob/c21be2741af6674b2f422d9891b57fc3d2ba5b7b/electron/window-lifecycle.ts#L226) 后直接 `performQuit`，跳过正在安装等确认。

当前真实模块 + EventEmitter 替身：普通退出结果 `cancelled`，确认 1 次、退出 0 次；发出 query、随后不发结束事件，稍后正常退出为 `quit-requested`，确认 0 次、退出 1 次，标志仍 true。结果同在 `core-helper-repro-results.json` 的 D15 字段。这里只验证应用内部状态机，没有发真实 Windows 消息或执行关机。历史关于操作系统取消消息的材料沿用 `xingmang-deep-audit-20261027-ffc04922/root-extra-findings.md`，本次未重新联网核实 Electron 上游实现。

修复应区分“询问关机”与“确认结束”，为询问状态添加可靠的取消/失效机制；不能削弱真关机时恢复系统代理的清理。验收至少包含：query 后取消、稍后正常退出仍可被确认取消；实际结束不弹确认；需要代理清理时仍阻止过早退出；重复 query、已有关闭框、清理超时均保持幂等。当前测试 `window-lifecycle.test.ts:638-730,759-890` 钉住真实结束和准备/撤销更新退出，没有取消 query 后恢复正常退出的场景。

### #7 的修复与验收

将启动自动安装与其它自动安装路径统一使用可复用的工作状态判断，至少覆盖当前聊天/图像/视频/画布任务、renderer 活动和付款窗口。发预告之前及预告结束后都再次判断。保护不能仅是统计是否存在安装任务。验收：启动两分钟内、无安装任务而聊天/画布/视频正在工作，不调用 install；空闲对照仍能安装；预告期间开始工作也必须延后。对明确由用户确认重启的流程保留当前可理解的确认语义。

### D17 / D18 / D19 的建议验收（供对应 owner）

- D17：Windows HOME 与 `os.homedir()` 不同，使用同一根目录进行安装、扫描与卸载；已安装目标仍受现有路径/签名/所有者检查，不能通过放宽白名单修复。
- D18：普通用户首次安装原生 Grok、原 PATH 不含安装目录时，用户 PATH 恰好补入一次；失败有提示；不误用 npm shim 清理；提权边界保持原策略。
- D19：连续安装两个版本，程序自己的 `agent` 入口同步到新版本；用户自建入口不被覆盖；旧版本清理后两个受管入口均可解析。

## 覆盖账本与复用依据

121 个文件逐一 SHA-256 校验均匹配本次 inventory；118 个与历史只读源码快照字节一致。3 个变更文件为 `main.ts`、`system-service-context.ts`、`system-service.ts`，已完整阅读 `ffc04922..c21be274` 的这三文件 diff：macOS App Management 设置入口、存储桶版本查询工厂和依赖传递、安装请求参数接线。历史全文阅读 + 本次完整增量用于这 3 个文件的整体覆盖，不标记为全文 fresh。

- 55 个 source/config 文件：50 个可按当前/历史哈希一致复用旧全文阅读；3 个复用旧全文并补完整 diff；`bootstrap/main-source.test-support.ts`、`manual-uninstall-visual-fixture.ts` 的历史状态是 pending，本次补全文。其余关键调用链又做了本报告列出的 fresh 定向阅读。
- 66 个测试源码：`provider-launch-service.test.ts` 与 `renderer-release.test.ts` 本次全文；其余 64 个为 **targeted**，逐文件核对测试结构、mock/跳过边界、首尾用例断言片段，重点另读 lifecycle 和系统账号 work 用例。没有声称 8,055 行 `system-service.test.ts` 全文 fresh。
- `core-helper-test-index.json` 保存结构化索引（1,358 个 AST 用例定义，含参数化定义；不能当成执行用例数），便于后续定位，不是自动生成的测试通过证明。
- 历史覆盖依据为 `本地证据/merged-coverage.json` 的 **review** 字段及 ranges。原 `status` 字段仍是分配时 pending，不能拿它替代最终 review；本次哈希账本已明确纠正这一读法。
- `core-helper-coverage.json`（本地受控证据） 按文件记录 hash、review_level、review_mode、note。**full 表示组合阅读覆盖，不等于全部运行分支验证或无缺陷。**

常规链路的 reuse 范围包含 Claude Desktop 安全配置事务、manifest/policy 与安装下载、运行环境/扫描/卸载辅助、通知与托盘、窗口偏好/恢复、主服务门面和启动清理。本次没有从这些旧全文记录中推导“新增的真机验收通过”。

## 验证结果与未完成的外部边界

本分片仅运行 `node core-helper-repro.cjs`，退出码 0，验证 U05 与 D15 的反例和对照，输出附当前源码哈希。真实网络/子进程/CLI/系统动作均为 0。未重复全套测试。旧全套结果见历史 `verification-final.md`：当时 Vitest 有 worker 异常，不能记成全通过；当前 Node 22 检查的最终结果见 [验证记录](../validation.md)。

另交叉报告的更新失败画布问题：`main.ts:2936-2955` 在更新安装准备阶段 dispose 画布，但 abort 仅恢复生命周期 flags 和遥控。画布与更新 owner 已联合确认，root 分配全局编号 **U02**；本分片只提供 main 接线证据，动态验证以两 owner 的报告为准，总报告合并一次，不与旧 #7 或本分片 U05 重复编号。

未做生产请求、真实 Windows 更新/UAC/关机、macOS/Linux 启动和安装、厂商客户端真实运行。本轮没有修改项目源码、用户配置或服务器。
