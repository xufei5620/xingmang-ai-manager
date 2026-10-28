> 统一审查报告的专项附件；固定源码基线为 c21be274，后续新增提交见 [最新增量复核](../latest-delta.md)。本页中的本地证据名称用于维护者对账，关键观察结果已在正文给出；完整受控材料不公开。

# 平台、代理与加速：当前代码复核及修复方案

基线：`c21be2741af6674b2f422d9891b57fc3d2ba5b7b`。固定审查基线。

本专项没有确认需要另计的新问题。直接负责范围内的 **6 个历史根因仍存在**：S02、D19、D20、D22、F03、F04。另交叉核对 D21、D15，供对应负责人合并，不能重复计数。没有修代码、改真实配置、修改系统代理、启动原生 helper、执行安装/卸载或请求任何服务器。

## 范围与证据等级

独占清单共 154 文件、45,207 行：82 个生产源码/配置、71 个测试、1 个 README。本轮逐文件计算 SHA256，154 个值均与给定 inventory 一致。82 个生产文件全部与前轮已完整阅读的固定源码相同；前轮 `ffc04922` 和后续 `1b0039c8` 的完整阅读记录及离线复现可以复用。依赖链中的 `cli-install-service.ts`、`provider-launch-service.ts`、`command-runner.ts`、`node-runtime.ts`、`tool-route-follow-service.ts`、`bootstrap/acceleration.ts`、`install-cancellation.ts`、`window-lifecycle.ts` 同样与旧基线相同；两桌面安装服务与 `1b0039c8` 相同。

本轮覆盖记录的精确含义：

| review_level | 文件数 | 含义 |
|---|---:|---|
| reuse-full | 82 | 生产源码已通过当前哈希对账，复用此前完整语义阅读；关键根因又作本轮定点核对 |
| fresh-full | 23 | 本轮全文阅读：22 个支持测试及 1 个 README |
| fresh-targeted | 7 | 本轮阅读具体测试体/夹具/断言，其他段落仅核对用例索引 |
| test-index | 42 | 本轮逐文件核对测试声明、平台门控与模块关系；**未逐行阅读全部测试体** |

因此，可以说全部生产源码的完整阅读证据已对齐当前版本，不能说本轮重新逐行读完了 154 个文件。支持测试中仍有 42 个仅到索引级、7 个只读了部分测试体。它们在 ledger 中明确保留，不以扫描结果充当 full。未执行新一轮全套或原生平台测试；下述运行证据均注明复用来源，不声称刚刚重新运行。

## S02

此安全条目已纳入 [公开状态与验收目标](../security-status.md)。详细触发条件、定位与受控复现保留本地，按仓库安全策略不随公开 PR 发布。

## D19：Mac/Linux 更新 Grok，agent 入口仍指向旧版

**当前状态：仍存在；P2。**

**触发与影响：** 第一次由星芒补建 `agent`，以后成功升级 Grok。`grok` 更新了，`agent` 仍运行首次安装的版本；旧文件清理后还可能失效。

**当前位置：** [macos-grok.ts:158](https://github.com/xufei5620/xingmang-ai-manager/blob/c21be2741af6674b2f422d9891b57fc3d2ba5b7b/electron/macos-grok.ts#L158)：存在任何 agent 就返回；首次链接指向具体版本文件。Linux 的 `linux-grok.ts:245–246` 共用它。

**证据：** 复用 `platforms-behavior-result.json`：首次目标 `grok-1.0.0`，第二次 canonical 已是 `grok-1.1.0`，agent 仍是 `grok-1.0.0`。本轮阅读 `macos-grok.test.ts:527–599`，现有用例明确断言所有既有链接不变；没有区分用户自建入口和本工具上次创建的入口。

**修复方案：** 为工具创建的 agent 保留可判定的归属/上次目标，升级时仅维护确认属于工具且未被用户修改的入口；或设计受控的随 canonical 更新方式。安装快照、失败回滚、卸载和历史版本清理必须同步处理，不能简单覆盖所有已有 agent。

**验收：** 首装 A、成功升级 B 后两个入口均到 B；升级失败后两个入口恢复到 A；用户自建链接、普通文件及安装过程中被用户修改的入口保持不变；Mac/Linux 两条调用链都覆盖；清理旧版本不使新 agent 断链。

## D20：Mac 继承 Bash 导出函数时，打开工具被无关环境项阻断

**当前状态：仍存在；P2。**

**触发与影响：** 从带 `BASH_FUNC_module%%` 等导出函数的 Bash 环境启动星芒，然后打开 CLI。该项本来不写入脚本，却先被环境键检查拒绝，正常工具也打不开。

**当前位置：** [macos-platform.ts:223](https://github.com/xufei5620/xingmang-ai-manager/blob/c21be2741af6674b2f422d9891b57fc3d2ba5b7b/electron/macos-platform.ts#L223) 先检查所有继承键，242–249 行才按固定白名单筛选。普通命令环境及启动服务保留并传入这些继承项。Linux 终端已有仅校验实际输出项的对应处理。

**证据：** 复用 `platforms-behavior-result.json` 的真实 `buildMacosTerminalScript`：正常环境通过，无关普通键被忽略，Bash 导出函数键触发 `invalid environment key`。本轮阅读 `macos-platform.test.ts:319–338`，现有断言要求未知非法键报错，未区分最终不导出的键。

**修复方案：** 先选择实际导出的白名单项，再校验和值转义；显式 unset 的键继续严格校验，HOME/PATH 必填检查保留。不要为绕过这一问题放宽所有 shell 变量名，也不要把任意继承值写入脚本。

**验收：** Bash 导出函数及其他不输出项不阻断启动、不出现在脚本内；真正导出的值含 NUL 仍拒绝；显式 unset 非法键仍拒绝；特殊字符参数保持字面值；脚本凭据白名单与临时文件清理对照不退化。

## D22：Mac 自动加速崩溃后，代理未恢复却漏掉主动提醒

**当前状态：仍存在；P2。**

**触发与影响：** 自动加速的 helper/内核退出，恢复系统代理被用户拒绝授权或被安排静默延后。系统代理可能仍指向已失效的端口，后台通知却按“已恢复，不打扰”处理。页面有错误不等于用户能在后台收到提醒。

**当前位置：** [acceleration-development-worker.ts:85](https://github.com/xufei5620/xingmang-ai-manager/blob/c21be2741af6674b2f422d9891b57fc3d2ba5b7b/electron/acceleration-development-worker.ts#L85) 对 withheld 恢复允许 init 成功；host 的 540–544 行以 init 成功得到 `recovered=true`；backend 的 545–547 行以计费账本 `startedAt` 判断 pending，自动会话可能返回 error；[acceleration-interruption-notice.ts:152](https://github.com/xufei5620/xingmang-ai-manager/blob/c21be2741af6674b2f422d9891b57fc3d2ba5b7b/electron/acceleration-interruption-notice.ts#L152) 将 error 也归为 restored，并在 104–106 行静默。

**证据：** 复用 `network-interruption-repro.json`：真实 backend + notice，恢复尝试 4 次，状态明确说网络设置尚未改回，通知数组仍为空，出现 `acceleration.interrupted.quiet`。本轮全文阅读 interruption notice 测试，另读 host:186–263、343–408 及 backend:803–920；现有测试各自覆盖 init 成败、自动会话和通知，却没有覆盖“init 成功但恢复 withheld”的组合。

**修复方案：** 将代理恢复状态与 helper 就绪、计费状态分开。通过结构化状态明确表达已恢复/待恢复/授权延后/失败，并将它传到通知判定；不要把所有 error 都认成 restored，也不要为表示恢复状态而开始给自动免费会话记费。继续保留避免重复弹密码框的设计。

**验收：** 自动会话崩溃 + 授权拒绝和 quiet deferred 两个组合，都至少给出一次“网络可能未恢复”的提醒；已确认恢复才静默；正常付费会话、用户主动停止、已重新连接、换账号和重复事件的去重仍正确；恢复失败不反复弹授权框。

## F03：Mac 更新接受取消后仍可能提交新版

**当前状态：仍存在；P2；沿用同一旧 ID。**

**触发与影响：** 取消请求被接受，但文件替换继续成功，用户得到的“取消”与实际版本不一致。需要准确分阶段：外部客户端的关闭等待路径未传取消信号；ChatGPT/Codex 路径传了 signal，关闭等待期间可被中止，但关闭完成进入提交边界后仍可接受取消并完成更新。

**当前位置：** [macos-desktop-app-installer.ts:729](https://github.com/xufei5620/xingmang-ai-manager/blob/c21be2741af6674b2f422d9891b57fc3d2ba5b7b/electron/macos-desktop-app-installer.ts#L729) 的 `replaceBundle` 在 745 行 await 关闭，之后 748、756 行 rename，没有最后取消检查或提交封口；`codex-desktop-service.ts:3406–3411` 传 signal，3776–3777 的取消入口仍接收请求。两服务当前源码与 `1b0039c8` 相同。

**证据：** 复用 `mac-update-result.json`，真实临时 bundle 在 beforeReplace 等待期间取消后仍由 `1.18.30` 换成 `1.18.34`。ChatGPT 服务专门对照见 `本地证据/chatgpt-mac-service-result.json`：关闭等待取消为 0 次替换；提交边界返回 `cancelled:true` 却返回 updated。后者提交动作是 mock，不能冒充 Mac 真机。当前安装器测试 1066–1082 行只覆盖下载/检查阶段取消。

**修复方案：** 定义唯一、明确的不可取消提交边界。关闭等待支持 signal；关闭完成后检查取消，在第一次破坏性移动之前同步封口取消状态；提交开始后取消入口返回“已进入完成阶段”，界面禁用/说明。不要在旧版已经挪走后仅靠再抛取消错误退出，必须完成提交或恢复。

**验收：** 下载、检查、关闭等待、最后可取消点分别取消，均保留旧版并回取消；提交封口后请求取消必须返回不可取消而非成功取消；两个 rename 中任一失败仍恢复旧版/留下可恢复备份。ChatGPT、Claude Desktop、OpenCode 都用同一阶段契约验证。

## F04：Mac 更新用下载前的旧版本快照判断，可能降级

**当前状态：仍存在；P2。**

**触发与影响：** 工具开始下载后，客户端自行升级到了更高版本；最后工具仍按下载前版本判断，把刚升级的应用换回较旧版本。

**当前位置：** [macos-desktop-app-installer.ts:1161](https://github.com/xufei5620/xingmang-ai-manager/blob/c21be2741af6674b2f422d9891b57fc3d2ba5b7b/electron/macos-desktop-app-installer.ts#L1161) 只比较传入的初始 `installedVersion`，`replaceBundle` 不读提交时的真实版本。ChatGPT 服务 3403、3428–3437 行只传一次版本快照，beforeReplace 仅处理关闭。外部客户端相同。

**证据：** 复用 `chatgpt-mac-install-result.json` 最后一项真实 `tool:'codexDesktop'` 临时文件链：下载前 `26.900.1`，下载期间自行升级到 `26.999.1`，提交前文件仍为 `26.999.1`，最终被替换为 `26.930.2`。通用 OpenCode 对照在 `mac-update-result.json`。当前测试 561–568 行只验证初始参数已经较新时不替换，未覆盖下载期间发生变化。

**修复方案：** 关闭完成后、提交新版前重新检查目标 bundle 的实际身份和版本；若目标等于或高于下载版，保留目标并返回它的真实版本/unchanged。目标已变且无法确认时停止并保留现状。将这一步与提交/备份状态连接，避免读旧快照后无条件替换；处理已经移动到备份时的版本冲突也必须可恢复。

**验收：** 下载期间 A→C、待装 B 且 A<B<C，最终保持 C；A→B 最终保持 B；目标消失/元数据不可读不得报告 B 已安装；普通 A→B 成功、替换失败回滚、同名非官方应用保护不变。两个应用目录与三个受管 Mac 桌面客户端覆盖。

## 交叉范围旧项，不在本专项重复计数

| 旧 ID | 当前核对 | 修复与验收要点 |
|---|---|---|
| D21 自动切线重试成功漏重开提醒 | `tool-route-follow-service.ts` 及本清单 `bootstrap/network-routes.ts` 当前与旧证据源码相同；复用 `network-route-retry-repro.json`。首次失败、重试成功后配置已改，运行检测 0 次，提示为空；直接成功对照有提示。 | 待重试 provider 保留 fault 语义；首次失败后成功须补运行检测与重开标记；重复重试只提醒一次，普通非故障改线保持原语义。由线路服务负责人合并。 |
| D15 取消 Windows 关机后状态不复原 | 根因 `window-lifecycle.ts` 不在独占清单；当前哈希与旧证据相同。这里只提供一致性核对，不抢该文件负责人范围。 | 用户取消关机后恢复普通退出确认与安装/任务拦截；用事件 mock 对照普通退出、确认关机、取消关机后再退出，不执行真实关机。由生命周期负责人合并。 |

旧 12（提权卸载安装位置）、D17/D18（Grok 安装/卸载服务）、N10（多副本运行检测）、F05（更新后自动重开）由各自服务/UI 负责人归并；没有把其结果变成独立的 Windows 提权层或平台层新问题。

## 本轮未提升为新问题的事项

- Rosetta 下首次芯片探测异常被缓存为 x64：前轮离线证据有效，但未证明当前 Intel 包在 Apple 芯片真机不能运行；保留观察，不提升为安装必失败。
- `Codex.app` 老名可检测但不属于当前 `ChatGPT.app` 替换路径：按既有兼容性限制记录，不重复报新缺陷。
- Mac 卸载在 prepareQuit 失败后继续的分支：独立 helper 仍可能完成恢复，尚不能仅凭吞错认定卸载必然断网。
- Mac/Linux 同 uid 替换、ACL 未检查、Mac admin 组信任，以及 Windows 未知完整性/权限探测的既定回退，均按当前明确设计边界处理，没有改写为新漏洞。
- Windows 提权脚本、可信系统路径、代理 CAS/lease 与 Linux root/sandbox 约束的生产源码已哈希对齐前轮完整阅读；本轮未发现足以新登记的根因。这不是原生三平台安装验收通过的声明。

## 交付与后续验收约束

`platform_network-coverage.json` 每个清单文件含 path/hash/review_level/note；`platform_network-test-index.json` 保存测试声明及平台门控索引；`platform_network-reused-evidence.json` 记录复用结果及当前相关文件哈希。42 个 index 级测试体尚未 full 阅读，不能在总报告中抹平这一限制。

本轮没有执行测试、没有更改源文件。以后真正修复时按各项场景补回归，再遵守项目 `typecheck`/`npm test` 等提交门槛；Mac/Linux 原生命令、签名、终端、代理授权和恢复须由对应平台真机验收，Windows 上的离线 mock 不能替代。
