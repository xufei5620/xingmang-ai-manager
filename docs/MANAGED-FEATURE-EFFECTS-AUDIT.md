# 星芒对外部工具功能开关与配置改写的全面审计

日期：2026-10-04。审计基线：`e97392ab7e8e6aa99305b0e56f48cec61c4a4688`（0.2.15 源码）。本 PR 交付研究结论、完整策略清单和修复顺序，不修改业务行为、用户配置或系统设置。

## 1. 结论

确实还有其他被星芒关闭、收窄或覆盖的设置。主要包括各 CLI 的自动更新、Claude Code 的插件自动更新、Codex 共享后台服务自动启动、Claude 的部分工具、Grok 的 Claude hooks 兼容，以及 Claude Desktop 的模型列表。

并非每项都是缺陷：有些是固定受验证版本、避免不兼容中转请求或保护提权边界。真正需要优先处理的是**一个开关影响了额外功能、覆盖了用户明确选择，或者切换来源/卸载后没有正确恢复**。

本次新增的直接复现包括：用户隐私选择被恢复流程删除、用户上下文阈值被迁移删除、受管画图 MCP 的工具权限被重建覆盖、账号快照导致插件/MCP 配置在不同模式间分叉。此前中文缓存问题还影响整个 Statsig 功能缓存，不仅是中文；另找到两个具体界面消费者，但只证明条件影响，未把它们当客户现场故障。

## 2. 范围与证据等级

“全面”指这一个固定基线中，星芒对所管理对象的能力开关、配置写入、启动环境、网络策略和恢复流程的系统盘点，不等于逐个运行所有上游客户端功能。

| 审计面 | 已覆盖的主要位置 | 验证方式 |
| --- | --- | --- |
| 四 CLI 的持久配置、merge/reset/补模板/切官方/清理 | config-files、codex-config-migration、codex-context-limits、claude-model-picker | 源码逐分支；合成 HOME 调真实函数 |
| 模型与认证来源 | catalog、cli-model-defaults、codex-model-catalog、官方/中转快照 | 固定上游消费者与静态资产比对；配置事务复现 |
| CLI/桌面启动参数、环境净化、路径/证书 | tool-installation、command-runner、system-service、Win/Mac 启动模块 | 源码；网络交互 mock |
| 系统代理、下载代理与自动加速 | proxy-bypass、download-acceleration、download-proxy、codex-desktop-acceleration | 调用链与组合 mock；无真实线路操作 |
| MCP、Skill、Plugin 与托管通知 | provider-extensions、codex-extensions、xingmang-ai-mcp/skill、cli-hooks | 源码；纯函数偏好覆盖复现 |
| Codex/ChatGPT、Claude Desktop、WorkBuddy、OpenCode | desktop service/config/policy、external-tool-config/runtime、renderer-v2 registry | 源码；厂商一手配置资料 |
| 星芒自身选项与保护边界 | app-settings、updater、display-compat、platform-capabilities | 源码，区别自有设置与外部客户端设置 |
| Codex 官方前端缓存与界面开关 | Windows Appx 26.930.3930.0，内部 26.930.31730，Statsig 3.34.0 | 静态反查；16 场景隔离 SDK 机制实验 |

证据记号：**S**＝固定源码赋值/消费者已确认；**D**＝官方一手资料说明语义；**R**＝本次合成配置、纯函数或 mock 复现；**U**＝仍需目标版本真实客户端验证。代码注释中的历史复盘不计作本次重新完成的现场测试。

排除与限制：不读取真实 Key/token/会话；不访问生产模型或账号接口；不打开/重启客户桌面应用；没有 Mac 真机测试。Legacy 界面冻结，不在本 PR 作一般修复；共享主进程行为仍在范围内。工作区已有改动留在原处，研究在独立 worktree 完成。

逐项字段、入口、保留与恢复规则见 [完整策略清单](MANAGED-FEATURE-POLICY-INVENTORY.md)。以下是优先结论，不以这份摘要代替清单。

## 3. 优先发现

### F01 Codex 关闭统计会连带关闭全部功能评估缓存

**性质：已确认的跨功能副作用；优先级 P1；S+R，原生 UI 整体验收仍 U。**

星芒 `disableCodexRelayAnalytics` 在未表态时写 `analytics.enabled=false`。当前官方桌面读取该值后，同时选择 `loggingEnabled=disabled` 和 `disableStorage=true`；仍然允许请求功能开关，只是不持久保存。

16 项隔离 SDK 实验确认：存储启用、正常 initialize 曾取得 true 时，新进程离线能读 Cache；存储关闭时首次在线可以生效，下次离线为 NoValues。此影响覆盖全部 Statsig evaluations。除中文外，已反查到默认 false 的“新建窗口”菜单入口和一条宠物安装弹窗路径：无可用网络值/缓存/覆盖时可能不出现。**不代表所有开窗、宠物或官方功能都被关闭，也不证明客户账户原本有这些开关。**

主路径：`config-files.ts` 的 `disableCodexRelayAnalytics`、官方 app 的 `config/read → iSn → DIs`。专题详见 [中文与缓存研究](RECON-CODEX-LOCALE-PERSISTENCE.md)。

建议：将星芒可控 CLI 的统计等待优化局限到 CLI 调用，桌面保留用户原选择；迁移必须证明字段来源。不能直接把所有 false 删除或改 true。官方 SDK 有独立存储/日志能力，但当前宿主未暴露等价独立设置。

### F02 Claude Code 的插件自动更新被 CLI 更新策略一起关闭

**性质：额外被关闭的维护能力；优先级 P2；S+D。**

星芒写 `DISABLE_AUTOUPDATER=1`，且在普通 merge 保存时强制写入，切官方保留、官方 reset 仍写。Anthropic 明确该变量同时关闭 CLI 与市场插件的自动更新；单独保留插件更新需 `FORCE_AUTOUPDATE_PLUGINS=1`，本仓没有配置它。command 来源插件仍有独立每会话行为，不把所有更新路径混称关闭。[官方更新策略](https://code.claude.com/docs/en/plugins/org#turn-updates-off-for-the-whole-fleet)

建议：继续固定受验证 CLI 版本时，应明确谁负责插件更新。可验证独立插件更新开关，或由星芒提供有状态、可回退的插件更新管理；不能默默停止维护，也不能因网络不稳就承诺官方自动更新必然可用。

### F03 切回官方的清理规则可能撤销用户自己的隐私与工具限制

**性质：用户选择来源误判；优先级 P1；S+R。**

已直接调用真实配置函数复现：

| 用户原值 | 操作 | 实际结果 |
| --- | --- | --- |
| Codex analytics 表只有 enabled=false，且没有旧官方快照 | 切回官方 | 表被删除，用户 false 与星芒默认无法区分 |
| Gemini privacy 只有 usageStatisticsEnabled=false | 保存中转，再切官方 | privacy 被删除 |
| Claude 用户已有 Artifact/DesignSync/Bash deny | 保存中转，再切官方 | 前两项同名 deny 被删，仅其它 deny 留下 |
| Claude 用户 skipWebFetchPreflight=false | merge 保存中转，再切官方 | 先强制改 true，再删除；未恢复原 false |

删除隐私 false 可能恢复上游默认行为，不能说这是“恢复用户原样”。`ToolConfigOwnershipStore` 证明的是路径、账号端点和凭据身份，并不记录每个权限/统计字段的原值，不能补足这个证据缺口。

建议：增加字段级写入记录与 before/after，恢复时只处理有来源证明且当前仍等于星芒写入值的字段。旧存量无法判源时保留隐私/deny 选择，并提供针对性的解释与恢复入口；不做“全部恢复默认”。

### F04 Codex 启动迁移会删除用户自己的有效上下文设置

**性质：迁移范围过宽；优先级 P1；S+R。**

`runCodexContextLimitsMigration` 在主进程启动时按 CODEX_HOME 执行一次，`removeCodexContextLimitsFromConfigs` 覆盖活动、官方和中转快照；顶层 `model_context_window`、`model_auto_compact_token_limit` 只要存在就删除，不核对是否历史模板值或星芒所有。合成的 250000/170000 也被删除，嵌套 profiles 保留。配置事务有备份，不能说文件不可恢复。

这两个字段仍是上游有效配置，与按精确旧值清理废弃字段不是同一类动作。建议仅迁移可证明属于星芒的历史设置；无法确认时保留，另提供显式“使用模型默认值”。

### F05 受管画图 MCP 的用户工具权限会被覆盖

**性质：同步整条重建导致用户选择丢失；优先级 P1；S+D+R。**

- Gemini：用户把现有受管服务设为 `trust=false` 并排除 generate_image，下次同步重建为 `trust=true`，排除列表消失。trust 会免除该服务器工具调用确认。[Gemini 配置](https://geminicli.com/docs/reference/configuration/)
- Codex：用户把 generate_image 的 approval_mode 设为 prompt、添加 disabled_tools，下次重建为 approve，禁用工具列表消失。**整个服务的 enabled=false 会保留**，所以不能说已经被强行运行；当服务启用时，工具级偏好已经不同。[官方工具级配置](https://learn.chatgpt.com/docs/config-file/config-reference)
- 同名但不是星芒脚本的 MCP 保持不动；Claude 针对该服务的 deny/ask 也有保护。问题范围是“确认属于星芒条目之后重写过宽”，不是所有 MCP。

建议：只维护必要的命令、脚本路径、配置引用和可证明的默认超时；对 enabled、approval、trust、include/exclude/disabled_tools 等用户字段保留并测试。

### F06 账号整份快照会把插件与 MCP 配置分成两套

**性质：模式切换的设置范围冲突；优先级 P2；S+R，原生 UI 展示仍 U。**

合成流程：已有官方配置 → 切中转保存快照 → 在中转配置新增插件开关/MCP → 切官方恢复旧整份快照。新增项从当前活动配置消失；切回中转又出现。文件实体没有被删除，本次也没有验证原生 cache 在缺配置项时是否仍显示 installed/enabled。

这能形成“换来源后连接/插件状态变了”的配置机制。建议区分账号路由/凭据、普通偏好、插件开关与可能含敏感认证的 MCP 设置。不能把两份文件直接合并，避免把一个账号的认证数据带到另一个账号；需按字段范围和冲突规则处理。

### F07 星芒 AI Skill 的手动关闭会被账号派生开关覆盖

**性质：账号可用性覆盖用户启停选择；优先级 P2；S+R。**

`syncXingmangAiSkillCodexAvailability` 以 officialCodex 的反值决定 enabled；保存中转配置/切回中转时会写 true。纯函数复现确认，已有 enabled=false 被改成 true。切官方关闭自己的收费 Skill 有明确理由，但“账号可用”与“用户想启用”是两个状态。

建议最终 enabled 使用“账号允许且用户启用”，迁移记录区分因账号临时停用与用户手动停用；不扩大到其他 Skills。

### F08 Claude 权限默认需要作为独立产品选择说明

**性质：主动权限行为改变，不是功能故障结论；优先级 P1 评审事项；S+D+R。**

Claude 新建/reset 模板写 `permissions.defaultMode=bypassPermissions` 及 `skipDangerousModePermissionPrompt=true`，普通 merge/补模板不改已有权限模式；切官方 merge 会继续保留这两项。合成配置已复现。上游将 bypass 定义为跳过权限确认，不应称为无功能影响的性能优化。[官方权限模式](https://code.claude.com/docs/en/permission-modes#bypass-permissions)

建议把权限模式与 API 来源独立展示和保存，明确初始化/reset 的结果；不在这份研究 PR 中替现有用户改权限，也不凭“切官方”就无条件放开或收紧。

### F09 其他有意关闭或收窄应说明责任与恢复边界

**性质：明确产品/兼容取舍；S，部分 D。**

- Codex 关闭 CLI 启动更新检查；merge 会覆盖用户 true，自动补模板却只填缺省。它不是桌面应用更新总开关。
- Codex 默认关闭 daemon 自动启动，并在已识别版本 CLI argv 中加 --no-daemon；不等于关闭所有子代理/后台活动，也不保证已有 daemon 不被复用。
- Gemini 同时关闭 CLI 自更新与更新提醒；Grok 关闭自更新。切官方并不全部撤销这些版本治理策略。
- Claude deny Artifact/DesignSync；WebFetch 安全预检被关闭但 WebFetch 本身没有被关闭。
- Grok 缺省关闭读取 Claude hooks 的兼容路径，目的是避免错误重复执行；Grok 自己的 hooks 仍可用。
- Claude Desktop 强制模型列表为选中一个，防止此前 Mac 多模型兼容问题；不要未经验证就把名单放开。
- 自定义第三方端点会被星芒“打开工具”入口拒绝；这不代表官方客户端本身禁止该端点。

这些项的保留和恢复条件在清单中逐一列出。改进重点是透明、可追溯、用户选择能持久，而不是把所有 false 翻成 true。

### F10 整体直连回退与后来启用加速之间存在状态冲突

**性质：跨模块条件性错误；优先级 P2；S+R（纯模块 mock），真实网络结果仍 U。**

先因本机系统代理失败，`proxy-bypass.attempt` 将星芒 defaultSession 固定为 direct。稍后星芒启用系统加速，但下载后端发现系统会话已活动，就返回 system-proxy-active；下载协调器因此给出 accelerated=true、endpoint=null。main 的 downloadFetch 没有专用 endpoint 时仍走 defaultSession，而该 session 还保持 direct。默认下载源选择还可能因“已加速”转成官方优先；用户显式 mirrorPolicy 会保留。

纯模块 mock 得到以下状态，未加载 Electron、未访问真实代理或执行安装：

```json
{
  "bypassActive": true,
  "sessionMode": "direct",
  "leaseAccelerated": true,
  "leaseEndpoint": null,
  "defaultFetchRoute": "direct",
  "laterFailureReplay": false,
  "setProxyCalls": ["direct"]
}
```

独立下载加速本身没有错；这里是它假定“系统代理会负责”，与本进程之前的 direct 状态冲突。建议在加速获取前核对实际 session 路由，或者显式提供专用下载 endpoint；恢复必须保护用户自己的连接和站点单独直连策略。成功切直连之后，后启加速的这条链没有重新设置 defaultSession system，重启会清除这次 override；客户机器上是否出现安装失败仍需验证。

相关证据模块在先前读取的 23d60d76 与本 PR e97392ab 字节无差异；system-service 的队列取消变更不改变这里的下载源选择分支。

## 4. 本次没有确认的“全局禁用”

没有找到星芒模板统一关闭全部插件、MCP、Skills、联网搜索、浏览器或全部子代理的写入。

- 模型目录里的 include_*_usage_instructions=false 等字段来自固定官方模型资料；消费者控制通用使用说明，不等于注销工具。不能仅凭 JSON 里一个 false 判定关闭功能。
- Claude Desktop 的 disableAutoUpdates 命中是只读企业策略检查，没有看到向注册表/MDM 写禁更新。
- API Key 与 ChatGPT 登录可用的云端目录/授权流程不同；这是认证/服务能力边界，不能全部算星芒关闭。
- 扩展列表读取失败导致星芒页面标为不可列出，和修改外部工具配置使它禁用不同。
- 提权环境禁止注入变量、可信路径、网络白名单、Linux 沙箱检查是安全边界，不建议为找回功能而取消。
- 星芒自己的自动更新、桌面通知和 GPU 加速缺省开启；启动自动诊断缺省关闭。它们不是外部 CLI 设置。

“未找到”限定于清单列出的基线与写入范围，不代表所有上游客户端、版本和插件运行条件均已验证。

## 5. 统一整改设计

### 设置归属与作用域

新增可审计的设置策略记录：工具、字段、作用域、原值是否存在、原值/摘要、星芒写入值、模板版本、写入原因、是否用户显式选择、恢复条件。不在日志或渲染普通查询中暴露密钥；含认证的字段使用现有安全存储路径。

每次操作区分四类：首次缺省补齐、用户选择导致的强制修改、受管路径修复、切来源/卸载恢复。自动补模板与普通保存采用一致的显式值保护规则。字段记录丢失、被用户改动或来源不明时不自动撤销隐私/限制设置。

账号切换保留认证隔离：只对已定义为共享的非敏感偏好进行三方合并，账号相关 MCP 凭据、模型路由和 Key 不混入另一个账号。reset 继续是显式重建操作，界面要给出清楚范围。

### 用户界面

在工具配置结果或诊断中提供“星芒调整了哪些设置”的简明清单，例如“CLI 更新由星芒管理”“画图工具需要确认”“插件自动更新当前关闭”。只在用户需要决定时显示技术细节，普通成功流程不弹一串术语。

恢复按项进行，并保留必要备份；不提供无法证明原值的“一键全部恢复官方默认”。语言、权限、更新、账号来源分开说明，避免一个“连接成功”同时掩盖数种行为改变。

## 6. 后续实现拆分与验收

| 顺序 | 交付 | 核心验收 |
| --- | --- | --- |
| A | 字段归属记录和显式用户选择保护 | 先前 true/false/deny、同形自定义值、记录损坏、用户中途修改、merge/reset/补模板分别测试 |
| B | 隐私恢复、上下文迁移、受管 MCP/Skill 偏好修复 | F03/F04/F05/F07 的合成输入不再被误改；现有同名非受管内容保持 |
| C | CLI 与桌面统计作用域拆分 | 保留用户统计选择；真实双冷启动验证中文；新窗口/宠物入口按有资格账号核验，不能强设官方 gate |
| D | CLI 版本治理与插件更新分别接管 | Claude 插件更新路径有明确负责人/状态；Win/Mac 断网与恢复可重试，不悄悄升级未验证 CLI |
| E | 账号快照的字段范围重构 | 插件普通偏好不无声分叉，敏感 MCP 认证不跨账号泄漏，三方冲突可解释 |
| F | 用户可见的变更清单、权限策略及卸载恢复 | 用户明白改了什么；明确选择能维持；卸载只恢复可证明属于星芒的设置 |
| G | 代理回退与加速状态对账 | 先直连回退再启加速、用户自行切代理、租约并发、后续下载都使用真实可观察的路由；不误报已加速 |

自动测试使用合成配置和 mock 服务。真实 Win/Mac 验收覆盖首次配置、重复保存、启动补模板、切官方/切中转、升级、直接原生启动、卸载及备份恢复；分别检查菜单、配置、文件和实际能力，不能互相替代。

本次不自动改这些策略，尤其不取消安全净化、不替用户开启统计或权限、不向外部系统发调查消息。

## 7. 本次验证与交付状态

- 固定 e97392ab 源码上的 Codex 7 组合成配置观察/断言；三家 CLI 4 组合成配置；受管 MCP/Skill 3 个纯函数场景。根代理独立核对关键输出，均不触及真实用户 HOME。
- 复用同版本官方包的 16 场景 SDK 机制实验，补充两个真实界面消费者的静态调用链；不是原生 UI 故障复现。
- 相关既有 4 文件测试：257 passed / 3 skipped。
- `npm run typecheck` 通过。
- `npm test` 未全绿：551 文件通过、5 文件失败、6 跳过；9,818 用例通过、9 失败、367 跳过，另 1 次 worker 意外退出。9 项均为 Windows symlink EPERM；worker 原因未定位。未改断言或系统权限，也不把全部错误笼统归为环境。
- 命令在 Vitest 后停止，另行运行 scripts：主套件 478 passed / 44 skipped，post 套件 258 passed / 2 skipped，均 0 失败；browser 24/24 通过。
- 文档内部链接、围栏、编码、diff 与 changelog 检查随 PR 完成。

本 PR 是研究与整改建议，不宣称上述功能问题已经修复；Mac、真实客户网络、上游账号权限和实际插件运行仍在 U 范围。

另外保留三个源码候选，未提升为已证实客户故障：SOCKS4 解析为 SOCKS5 的兼容性、Mac 恢复代理对其它回环代理的归属判断、Mac Terminal 中未显式导出/取消的环境值是否残留。它们需要协议或 Mac 真机验证，不能因代码看起来可疑就改动安全/网络策略。

## 8. 关键扩展结论的复核定位

本机官方 Windows bundle 限定内部版本 26.930.31730。下面的字符偏移仅方便定位，函数/消息名和门控 ID 才是复查锚点；不同 Unicode 解码工具的偏移可能略有差异。

| 结论 | 源码定位 | 不能外推的部分 |
| --- | --- | --- |
| 缺缓存影响“新建窗口”菜单 | app-initial-74dc12f48352.js 约9726999读取gate 459748632，发送electron-desktop-features-changed的multiWindow；main-C_jM0dPl.js 约3331619只在multiWindow为真时插入newWindow菜单项 | 未证明其它开窗方式禁用；不是客户账号已获开关的证据 |
| 缺缓存影响宠物安装弹窗路径 | app-initial的$Os读取gate 1848317837，open-pet-install-modal回调在真值时才import PetInstallModalHost | 未证明所有安装路径或已装宠物失效 |
| 缺失gate默认false | app-initial导入Hc，映射shared的oK/rK，读取getFeatureGate.value缺省false；订阅更新可在取到官方值后改变结果 | 关闭缓存不阻止同一次启动取得新网络值 |

模型资料与功能消费者使用固定 `openai/codex a956835d020762cb2b570053af06f643a11c0ecc`：

- include_skills_usage_instructions 由 [CatalogContext](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/ext/skills/src/world_state_catalogs.rs#L125) 和 [通用说明片段](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/ext/skills/src/fragments.rs#L17) 消费，显式技能正文及工具注册有独立路径。
- Apps/插件说明在 [world_state](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/core/src/session/world_state.rs#L255) 决定；[工具规划](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/core/src/tools/spec_plan.rs#L150) 和原生插件安装处理器独立工作，不能由三个说明字段推断工具未注册。
- 外部模型资料经 [ConfiguredModelProvider](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/model-provider/src/provider.rs#L421) 选择 [StaticModelsManager](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/models-manager/src/manager.rs#L371)，其数组取代内置资料；这支持“需要维护资产版本”，不支持“把官方false全部打开”。
- CLI 更新与后台模式分别对照 [updates](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/updates.rs#L27)、[startup_orchestration](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tui/src/startup_orchestration.rs#L494)，不能将 CLI 设置外推为桌面全局关闭。
