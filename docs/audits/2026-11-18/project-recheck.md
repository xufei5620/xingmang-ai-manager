# 2026 年 11 月 18 日全项目复核

本页逐项对照 10 月 29 日台账，并记录本轮新确认的问题。基线为主分支 `ca72c206`，距上一轮产品基线新增 350 次提交，涉及 1,452 个文件。复核按原编号、有关调用链及新增变动抽查，未逐行重读所有变化文件。 [基线提交](https://github.com/xufei5620/xingmang-ai-manager/commit/ca72c2062e6b934cad45af18206db083f2bd3730) · [上次台账](../2026-10-29/issues.md) · [上次新增问题与验收目标](../2026-10-29/findings.md)

**91 个既有问题已逐项核对，31 项已修复、6 项部分修复、49 项仍存在、4 项条件性仍在、1 项入口已下线。** 原先的 16 项问题与 1 项风险中，9 项已修复、7 项仍在、1 项条件性仍在。全项目本轮新确认 A01–A09；3 个 WebSocket 验收缺口和历史材料在下面单列。

> **云端核实（11-18）**：A01–A09 都读代码核过，属实，按本项目口径都是建议级；A04 在画布内核里，要先在 xingmang-canvas 修。91 个旧编号云端只抽查了 15 条（含「优先处理」的 N2、F03、F04、R28-3），都对得上；R29-06 跟云端 11-17 的结论不一致。详见 [云端核实](verification.md)。

| 来源 | 已修复 | 部分修复 | 仍存在 | 条件性仍在 | 入口已下线 |
|---|---:|---:|---:|---:|---:|
| 原 84 个编号 | 29 | 3 | 47 | 4 | 1 |
| 10 月 29 日追加的 7 个编号 | 2 | 3 | 2 | 0 | 0 |
| 合计 | 31 | 6 | 49 | 4 | 1 |

**优先处理**　视频提交结果不明且记录写入失败时，重开会丢掉再次提交前的提醒（N2）；Mac 更新可能忽略已接受的取消或覆盖刚装好的更高版本（F03、F04）；切换账号后工具配置可能仍属于原账号（R28-3）。与上次相比，已完整修复的新增编号为 O05、O06、O16、N8、D04、D20、D26、S02、R2-1、U04、R29-04、R29-07。

## 本轮新增 9 项

P2 建议进入近期修复，P3 可随后排期。“新增”表示本次确认，并不指定引入问题的版本。下列对照均使用隔离的本地环境。

### A01 · P2 · 打开已保存的视频草稿，第二次保存失败会丢掉这份草稿

在真实浏览器中模拟第二次保存失败，重开后当前工程和草稿箱都指向原草稿，选中的另一份分镜消失。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/src/renderer-v2/features/video-studio/project.ts#L731)

**修复与验收**　将工程与草稿箱一起提交，或待新工程存好再移除原稿。分别让两次写入失败，并在中途退出；重开后两份草稿都应能找回。

### A02 · P2 · 生成的图片只留在内存时，界面没有提醒退出就会丢失

仅存在内存的图片，重启后恢复数为零；磁盘暂存的对照可恢复一张。两种情形当前给出相同提示。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/bootstrap/ai-services.ts#L244)

**修复与验收**　分别提示实际保存位置。仅存内存时提醒用户先别退出，或提供另存入口；验收原进程重试和退出重开。

### A03 · P2 · 切换账号后，Claude Desktop 后台补型号仍用旧账号继续测试

隔离对照中切换账号后，旧账号的后台工作仍有新的模型检测，最终没有写回旧菜单。没有发出真实模型请求。

**修复与验收**　切换、退出时终止旧账号排队的检测，并保护已在途的操作。验收正常完成、切换、退出和切回原账号。

### A04 · P2 · 素材库末页变成空页后，刷新报错，上一页也点不了

在临时素材库中删减文件后，原末页已超出范围；刷新仍报错，组件里上一页也被禁用。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/canvas-v2/src/components/account-asset-library-model.ts#L50)

**修复与验收**　刷新后回到最后一个有效页。测试文件数从 30 降至 20、删到零及恢复正常翻页；画布内核修改按来源仓同步。

### A05 · P2 · 暂存目录短暂读不到，恢复以后图片也不会自动补存

临时目录有一张图片，一次扫描失败后即停止自动重试。目录恢复后，手动调用恢复流程还能补存该图。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/ai-unsaved-image-stash.ts#L282)

**修复与验收**　区分已检查为空和目录暂时不可读。目录恢复后应自动入库，无需重新登录。

### A06 · P3 · 多账号共用一台电脑时，图片磁盘暂存可超过说明中的总上限

缩小测试上限后，两个账号各自写入到上限，合计为单个上限的两倍。尚未测真实磁盘满。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/ai-unsaved-image-stash.ts#L18)

**修复与验收**　明确共同限额并在写入时统一计算。验收跨账号合计达到上限时的反馈，同时保持各账号内容隔离。

### A07 · P3 · 已经闲置的 Codex 日志仍会一直被后台查看

对临时日志推进模拟时间，文件停止写入后仍被定期打开检查。没有测出真实卡顿或电池消耗。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-payload-limit.ts#L203)

**修复与验收**　只在文件实际变化时延长活动时间。验收停止写入后结束轮询，重新写入时仍能发现新的错误。

### A08 · P3 · 设置页显示的 AI 作品占用会漏算画布项目，切站后合计也会变

离线统计中，独立画布文件未被计入。文件未变，仅切换站点，显示的合计也随之改变。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/storage-usage-service.ts#L63)

**修复与验收**　说明统计范围，或逐站点汇总已登记目录并去重。用外置项目、两个站点和嵌套目录验收。

### A09 · P3 · 再次导入同一对话，会漏掉旧电脑后来写好的未发送草稿

只新增未发送草稿时，导出文件含草稿，再次导入却报告已有全部对话。旧电脑上的原稿仍在。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/src/renderer-v2/features/chat/storage.ts#L627)

**修复与验收**　消息相同也检查草稿与附件。本机没有草稿时补入；双方各有草稿时保留选择。验收重复导入不会覆盖或重复。

## 桌面安装、视频计费和 Codex 线路

- **ChatGPT / Codex 桌面安装。** Mac 的首次安装、正常更新、早期取消和替换失败回滚有临时应用对照；最后时刻取消及并发升级仍有问题（F03、F04）。Windows 存在正式版残留入口与 Beta 识别不一致的可能（D16）。这些结论不替代在对应平台上用正式安装包验收。
- **历史账号的视频请求。** 管理工具内置视频入口对历史账号提示不可用。主窗口和画布服务的四个相关拒绝检查通过；客户端按站点选取视频服务、凭据和任务记录，未发现内置入口自动用另一站点账号下单的路径。独立 CLI 有自己的配置与调用路径。文字分镜、内置视频生成和外部 CLI 应分别核对；实际模型上游、订阅消耗和账单结算仍需服务端证据。
- **Codex 的 413 与 WebSocket。** 历史 HTTP 413 只证明当次请求被拒。客户端配置、线路健康探测与一次完整模型会话分别取证。本轮没有新现场日志；验收时应在测试账号上核对同一任务实际使用的传输方式、失败原因、恢复结果与用户提示。

| 历史缺口 | 本次状态 | 已具备的保护 | 仍须验收 |
|---|---|---|---|
| H-WS-GAP-01 · 大请求失败的发现与恢复 | 部分修复 | 已能识别部分 413、切线并按线路提示。 | 验证监听恢复与短暂失败后还能处理原错误。小型探测不能代替大请求完成结果。 |
| H-WS-GAP-02 · 设置与实际连接 | 部分修复 | 星芒账号的切线流程会等待配置跟随并检查更新结果。 | 验证历史账号在窗口未打开时的配置跟随，并记录旧会话实际使用的传输方式。 |
| H-WS-GAP-03 · 传输验收范围 | 部分修复 | 已有固定版本 CLI 与本地中转的正常回答测试。 | 分别检查 WebSocket 实际握手、HTTP 回退、断线重连、续接状态和较大请求；单次成功回复不能区分传输方式。 |

## 91 个旧编号

表中“源码复核”表示从当前实现判断；离线、组件、浏览器及临时文件对照仅说明对应模拟条件中的行为。“条件性仍在”保留特定环境与现场条件，“入口已下线”保留与底层代码的区别。优先度沿用历史排期；已修项便于追踪原有回归。涉及安全的条目只列保护目标与状态。 [原优先度及修复方案索引](../2026-10-28/history-index.md) · [公开安全验收目标](../2026-10-29/security-status.md)

### 最初 16 项问题与 1 项风险

| 编号 | 旧优先度 | 问题 | 上次 → 本次 | 证据与验收 |
|---|---|---|---|---|
| O01 | P2 | 日志与反馈的凭据保护 | 已修复 → **已修复** | 源码复核。原范围内的日志与反馈出口保有凭据保护；保留正常和错误输出的脱敏验收。 |
| O02 | P2 | 普通星芒账号误用同组其他不限额 Key | 已修复 → **已修复** | 源码复核。签发时仍按账号和工具用途选用记录。继续验收同组有多份密钥时的归属和限额。 |
| O03 | P2 | 历史账号换订阅分组丢失限额和到期日 | 仍存在 → **仍存在** | 源码复核。更换分组尚未完整继承客户端的原有约束。验收换组前后额度与有效期一致。 |
| O04 | P1 | 复制画布后提示复用缓存却重新生成 | 已修复 → **已修复** | 离线对照。画布复制后能复用有确切来源的素材，预检也会告知可能新增的请求上限。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/canvas-v2/src/runtime/run-preflight.ts#L207) |
| O05 | P2 | 剧本解析漏算付费调用 | 部分修复 → **已修复** | 离线对照。剧本解析提示最多两次请求；正常、纠错、失败和取消分别没有超出预告。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/canvas-v2/src/runtime/run-preflight.ts#L36) |
| O06 | P1 | 选了历史图片 A，下游仍使用图片 B | 部分修复 → **已修复** | 离线对照。历史素材仍可用时交给下游；缺失或无法读取时明确停止，不会改用另一张图。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/canvas-run-engine.ts#L988) |
| O07 | P2 | 启动自动更新打断聊天或画布 | 仍存在 → **仍存在** | 源码复核。启动时自动安装未覆盖所有前台工作，验收应包含聊天、画布和正在运行的任务。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/main.ts#L1744) |
| O08 | P2 | 旧登录恢复覆盖新登录凭据 | 仍存在 → **仍存在** | 源码复核。旧登录恢复操作与后来登录之间的归属保护还不完整。验收以最后确认的身份为准。 |
| O09 | P2 | 扩展操作慢返回后串到另一工具列表 | 已修复 → **已修复** | 组件对照。扩展操作慢成功和慢失败期间切换工具，另一工具的列表都能保持正确。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/src/renderer-v2/features/extensions/ExtensionsPage.tsx#L180) |
| O10 | P2 | MCP 换密钥失败却提示成功 | 仍存在 → **仍存在** | 源码复核。更换扩展配置失败时仍可能报告成功。验收应同时核对最终保存内容与提示。 |
| O11 | P2 | 保存或回滚配置覆盖其他程序刚做的修改 | 仍存在 → **仍存在** | 源码复核。保存和回滚仍可能覆盖期间由其他程序保存的版本。应检测冲突并保留外部修改。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/config-files-context.ts#L459) |
| O12 | P2 | 管理员模式卸载丢失实际安装目录 | 仍存在 → **仍存在** | 源码复核。同机存在多套安装时，卸载可能丢失已识别的目标。验收选择的目录与最终目录一致。 |
| O13 | P2 | 生成中改提示词，旧结果清掉待更新标记 | 已修复 → **已修复** | 离线对照。生成中修改输入，旧输出只留作候选；未改动时仍正常采纳新结果。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/canvas-v2/src/App.tsx#L3501) |
| O14 | P2 | 复制项目的素材仍被旧路径缓存牵连 | 仍存在 → **仍存在** | 临时项目对照。旧位置失效时全局读取失败，同一份素材仍能在副本打开。应重新定位有效副本。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/canvas-project-asset-manager.ts#L198) |
| O15 | P3 | 画布小地图、专注模式和面板偏好不保存 | 已修复 → **已修复** | 离线对照。更改的界面偏好下次能读回，另一个项目保持自身设置。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/canvas-v2/src/App.tsx#L1871) |
| O16 | P2 | 按 / 搜索落到隐藏页面 | 仍存在 → **已修复** | 浏览器对照。搜索快捷键聚焦当前可见页面；没有适用搜索框时按键保留原用途。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/src/renderer-v2/features/shell/Shell.tsx#L130) |
| O17 | P2 | 本地导入范围的完整性保障 | 条件性风险仍在 → **条件性仍在** | 源码复核。导入全过程与批准范围一致的条件仍待补齐。验收正常导入及异常中止后的完整性。 |

### 后续 11 项

| 编号 | 旧优先度 | 问题 | 上次 → 本次 | 证据与验收 |
|---|---|---|---|---|
| N1 | 保留回归 | 手机遥控显示已关闭，迟到的任务仍会启动 | 已修复 → **已修复** | 源码复核。原任务在关闭后的迟到处理已有保护。其他渠道的生命周期另见 R29-06。 |
| N2 | P1 | 视频提交结果不明确，重开后却显示“还没生成” | 部分修复 → **部分修复** | 浏览器和离线对照。普通结果未知能在重开后提醒；提交记录无法保存时仍可能漏掉提醒。应能查明旧任务再接受重试。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/ai-video-service.ts#L768) |
| N3 | P2 | 订阅确认框停留在旧价格，提交时没有核对价格 | 仍存在 → **仍存在** | 源码复核。订阅确认期间价格变化时仍可能显示旧价。下单前应确认当前条件与用户所见相符。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/src/renderer-v2/features/account/AccountRecharge.tsx#L473) |
| N4 | P2 | “另存图片”失败，原有文件可能已经被写坏 | 已修复 → **已修复** | 文件写入回归。图片、音频和视频另存失败时原文件可保全。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/ai-asset-store.ts#L869) |
| N5 | P2 | 切换账号后，先前点击的“打开”可能用新账号启动 | 仍存在 → **仍存在** | 源码复核。打开操作的归属可能随等待期间的账号变化。验收换号后只执行与当前意图匹配的任务。 |
| N6 | P2 | 密码实际改好了，软件却仍自动填旧密码 | 仍存在 → **仍存在** | 源码复核。改密结果不明时可能保留过期的自动填充信息。应区分确认失败、成功与待核对。 |
| N7 | P2 | 长聊天切到生图，短描述也被错误拦住 | 仍存在 → **仍存在** | 离线对照。长历史切到生图时，短描述也会被历史长度拦住。按实际发送内容检查长度。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/src/renderer-v2/features/chat/state.ts#L430) |
| N8 | P2 | 手机遥控的中文回复或审批内容可能变成乱码 | 仍存在 → **已修复** | 离线对照。两条中文分块回归通过。手机平台实际投递未在本项操作。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-remote-app-server.ts#L108) |
| N9 | P2 | 检测中途打开客户端，关闭后不会自动补切线路 | 仍存在 → **仍存在** | 源码复核。检测中途才打开的外部客户端可能漏掉关闭后的重新检查，应能恢复线路同步。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/external-client-route-service.ts#L573) |
| N10 | P2 | 同一客户端装了两份，会漏看第二份正在运行 | 仍存在 → **仍存在** | 源码复核。同一客户端多份安装时，检测未汇总所有副本的运行情况。应在每个副本均可安全更新时再改配置。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/external-client-runtime.ts#L909) |
| N11 | P3 | 新手引导把“先不打开”误当成完成 | 仍存在 → **仍存在** | 组件对照。选择“先不打开”后引导仍进入完成态。验收取消后可接着完成本步骤。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/ipc/handlers/launch.ts#L297) |

### 深审 27 项

| 编号 | 旧优先度 | 问题 | 上次 → 本次 | 证据与验收 |
|---|---|---|---|---|
| D01 | P1 | 切换画布项目后，“撤销”会覆盖另一个项目 | 已修复 → **已修复** | 离线对照。切到另一个项目后撤销保持在本项目，自己的后续编辑仍可撤销。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/canvas-v2/src/App.tsx#L2105) |
| D02 | P2 | 导入聊天记录，会悄悄删除原有对话 | 已修复 → **已修复** | 离线对照。聊天记录已满时跳过新增项并告知结果，保留全部原有对话。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/src/renderer-v2/features/chat/storage.ts#L710) |
| D03 | P2 | 便签里的网址、路径或 TODO 可能保存后消失 | 已修复 → **已修复** | 临时文件对照。六类含网址、路径或待办的便签可以保存并完整读回。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/canvas-v2/src/persistence/workflow-schema.ts#L124) |
| D04 | P2 | 切 API Key 后仍保留冲突的登录限制 | 仍存在 → **已修复** | 临时文件对照。显式切换到中转后正确处理冲突设置，切回官方来源时可恢复。 |
| D05 | P2 | 升级会把用户额外文件误认成软件文件，之后删掉 | 仍存在 → **仍存在** | 源码复核。安装目录里用户自己放的文件仍可能被列为软件文件。升级和卸载须保留无关文件。 |
| D06 | P2 | 选择“保留全部输入”，生成仍只用第一张参考图 | 部分修复 → **部分修复** | 离线对照。部分旧工程勾选保留全部输入后仍只使用第一张参考图。迁移时应核对完整清单。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/canvas-v2/src/lib/router-strategy-contract.ts#L29) |
| D07 | P2 | 短剧里的角色、场景可能错误连成同一道具 | 已修复 → **已修复** | 离线对照。相同编号的角色、场景与道具保持各自身份，改一个名称不会改到另一类。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/canvas-v2/src/library/drama-layout.ts#L28) |
| D08 | P2 | 选中的素材与详情操作对象对不上 | 已修复 → **已修复** | 离线对照。多选与取消后，详情及后续操作跟随实际选中项。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/canvas-v2/src/components/asset-selection.ts#L34) |
| D09 | P2 | 图片文件丢失时，会在两个失败地址间反复重试 | 已修复 → **已修复** | 离线对照。缩略图和原图都读取失败后保持占位，正常图片仍可显示。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/canvas-v2/src/components/MediaPreview.tsx#L32) |
| D10 | P2 | AI 回答被截断，也会显示成正常完成 | 仍存在 → **仍存在** | 离线对照。回答因输出上限或过滤而截断时仍可能显示已完成。应保留上游结束原因。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/ai-chat-service.ts#L597) |
| D11 | P2 | 切账号时，七日用量可能长期串到另一个账号 | 仍存在 → **仍存在** | 源码复核。跨账号的用量读取与缓存归属还不完整。验收两账号的七日统计互相独立。 |
| D12 | P2 | 配置出问题时，诊断报告反而导不出来 | 仍存在 → **仍存在** | 源码复核。一项诊断检查异常可能阻断整份导出，应保留可安全展示的其他检查结果。 |
| D13 | P2 | 会话归档后可能再也无法从界面恢复 | 仍存在 → **仍存在** | 源码复核。部分自定义归档目录写入后无法从界面恢复。应在归档前确认目标可被同一恢复流程读取。 |
| D14 | P2 | 导出会话时磁盘写入失败，会使整个应用退出 | 仍存在 → **仍存在** | 源码复核。会话导出写盘失败可能使应用提前退出。失败应只中止本次导出并保全已有文件。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/session-markdown-export.ts#L65) |
| D15 | P2 | 取消 Windows 关机后，软件会一直以为正在关机 | 仍存在 → **仍存在** | 离线事件对照。系统取消关机后，应用后续退出仍按关机处理。验收普通退出重新走完整流程。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/window-lifecycle.ts#L132) |
| D16 | P2 | 正式版残留入口会挡住已安装的 Codex Beta | 仍存在 → **仍存在** | 源码复核。Windows 识别到已安装 Beta 后仍可能选择残留的正式版入口。应按实际可用安装启动。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-desktop.ts#L130) |
| D17 | P2 | 自定义用户目录后，刚装好的 Grok 被判为不能卸载 | 仍存在 → **仍存在** | 源码复核。自定义用户目录时 Grok 的安装、检测和卸载使用位置不一致。应能找到并卸载同一份安装。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/cli-install-service.ts#L1199) |
| D18 | P3 | Windows 首装 Grok 后，自己开的终端找不到命令 | 仍存在 → **仍存在** | 源码复核。Windows 首装 Grok 后，用户自行打开的终端可能找不到命令。验收全新终端直接打开。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/cli-install-service.ts#L1217) |
| D19 | P2 | Mac/Linux 更新 Grok，agent 命令仍用旧版 | 仍存在 → **仍存在** | 源码复核。Mac/Linux 更新 Grok 后，其配套命令仍可能指向旧版本。更新和回滚后核对实际启动版本。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/macos-grok.ts#L156) |
| D20 | P2 | Mac 从某些 Bash 环境启动后，打开工具会失败 | 仍存在 → **已修复** | 离线函数对照。Mac 启动时兼容了无关的 Bash 环境条目；实际打开系统终端仍需真机验收。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/macos-platform.ts#L285) |
| D21 | P2 | 自动切线重试成功后，漏掉需要重开工具的提醒 | 仍存在 → **仍存在** | 源码复核。后台重试成功后可能漏掉重开工具的提示。验收初次成功与重试成功两条线路。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/bootstrap/network-routes.ts#L312) |
| D22 | P2 | Mac 加速崩溃后，网络未恢复却没有主动提醒 | 仍存在 → **入口已下线** | 源码复核。产品入口已下线，底层恢复能力的状态应独立核对。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/platform-capabilities.ts#L74) |
| D23 | P2 | 关掉自动更新，迟到的检查仍会自动下载 | 仍存在 → **仍存在** | 源码复核。慢更新检查返回时可能忽略用户刚关闭的自动下载。应按最新设置决定。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/updater.ts#L2354) |
| D24 | P3 | 导入主题显示成功，重开却变回旧主题 | 仍存在 → **仍存在** | 组件对照。主题导入后当下变色，持久设置仍是原主题。应在重开后保留导入主题。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/src/renderer-v2/features/settings/SettingsPage.tsx#L425) |
| D25 | P2 | 异常结束后的会话清理可靠性 | 仍存在 → **仍存在** | 源码复核。异常结束后会话清理责任仍待完善。验收回收正确对象并保留其他有效会话。 |
| D26 | P3 | 安全提醒的账号归属隔离 | 仍存在 → **已修复** | 定向回归。不同账号提醒的归属已分开；升级时已有提醒的原有效期可能延续。 |
| D27 | P3 | 大小写不同的两个项目，会少一个续聊入口 | 条件性问题仍在 → **条件性仍在** | 离线函数对照。大小写敏感文件系统上的不同目录可能合并，续聊入口变少。验收按系统规则区分。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/src/renderer-v2/features/tools/recent-workspaces.ts#L69) |

### 安全边界

| 编号 | 旧优先度 | 问题 | 上次 → 本次 | 证据与验收 |
|---|---|---|---|---|
| S01 | P2 | 更新安装内容与验证结果的持续绑定 | 条件性风险仍在 → **条件性仍在** | 源码复核。安装内容从验证至执行的完整性仍需条件性验收。 |
| S02 | P2 | 运行环境分发内容的整体完整性核验 | 条件性风险仍在 → **已修复** | 源码复核。原范围内的分发内容已有整体校验，Mac 原生安装另验。 |
| S03 | P2 | 旧回滚界面的账号上下文隔离 | 仍存在 → **仍存在** | 源码复核。旧回滚界面的账号归属保护仍不完整。验收不同账号各自恢复和发送。 |
| S04 | P2 | 外部输入处理的共享状态隔离 | 已修复 → **已修复** | 源码复核。原范围内的输入处理与共享状态隔离保护仍有效。 |

### 开发与发布

| 编号 | 旧优先度 | 问题 | 上次 → 本次 | 证据与验收 |
|---|---|---|---|---|
| T01 | P2 | 开发用影子目录不一定隔离日常 Codex 配置 | 仍存在 → **仍存在** | 源码复核。开发环境的配置隔离仍不完整。验收开发任务对日常配置零影响。 |
| T02 | P2 | 发布输入的请求前约束 | 仍存在 → **条件性仍在** | 源码复核。发布流程的输入约束仍需结合来源和运行条件验收。 |
| T03 | P2 | 发布下载页中途断线，可能把下载按钮全部弄没 | 仍存在 → **仍存在** | 源码复核。发布清单更新中断可能暂时影响下载入口。有效旧清单应一直可用，直至新清单完整就绪。 |
| T04 | P3 | 隐私政策弹窗可能显示用户协议正文 | 仍存在 → **仍存在** | 源码复核。切换协议与隐私政策时迟到的正文仍会覆盖当前弹窗。应核对正文与标题。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/dl-landing/app.js#L445) |
| T05 | P3 | 后台关闭邮箱验证，下载页仍显示验证码栏 | 仍存在 → **仍存在** | 源码复核。邮箱验证关闭后相关输入区仍可能显示。应按最新服务状态核对页面。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/dl-landing/index.html#L130) |

### 重复复查新增

| 编号 | 旧优先度 | 问题 | 上次 → 本次 | 证据与验收 |
|---|---|---|---|---|
| F01 | P2 | 刚设好的工具额度上限，会被一次改名取消 | 仍存在 → **仍存在** | 源码复核。额度与显示状态同步还不完整。验收仅改名称时保留用户最新设置的额度。 |
| F02 | P2 | 切到画布副本，会继承另一个项目的生成状态和候选图 | 已修复 → **已修复** | 离线对照。切换到画布副本后不会继承原项目的运行状态、选中状态或候选图。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/canvas-v2/src/App.tsx#L2105) |
| F03 | P2 | Mac 更新已接受取消，却仍继续换成新版 | 仍存在 → **仍存在** | 临时应用对照。较早取消能保留旧版；最后替换阶段接受取消后仍可能完成更新。验收界面反馈与最终安装一致。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/macos-desktop-app-installer.ts#L762) |
| F04 | P2 | Mac 更新可能把客户端从更高版本降回较低版本 | 仍存在 → **仍存在** | 临时应用对照。下载一份更新期间应用已更新至更高版本，管理工具仍可能覆盖它。替换前重新核对实际版本。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/macos-desktop-app-installer.ts#L1205) |
| F05 | P2 | 更新期间打开其他工具，Codex 更新后可能不自动重开 | 仍存在 → **仍存在** | 组件对照。另一工具正在启动时，更新后的自动重开可能被忽略。验收两项先后完成。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/src/renderer-v2/features/tools/useDesktopAppUpdate.ts#L104) |

### 10 月 28 日第一批

| 编号 | 旧优先度 | 问题 | 上次 → 本次 | 证据与验收 |
|---|---|---|---|---|
| R28-1 | P2 | 自家已经有新版，Windows 界面仍可能不给更新入口 | 仍存在 → **仍存在** | 源码复核。界面判断更新用的版本来源与实际安装可能不同。验收自家已有新版时有可用入口。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-desktop-service.ts#L2964) |
| R28-2 | P2 | 聊天记录刚导入成功，又被自动保存删掉 | 已修复 → **已修复** | 存储和组件回归。导入期间进入聊天、延迟保存时，导入记录可保留。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/src/renderer-v2/App.tsx#L422) |
| R28-3 | P2 | 界面切到账号 B，工具仍使用账号 A 的配置 | 仍存在 → **仍存在** | 源码及正常用例。工具检测未返回时切号，仍可能漏掉配置同步。旧慢检测界面场景本轮未重跑。 |
| R28-4 | P2 | 视频确认用一种模型，后面的镜头却自动换了模型和时长 | 已修复 → **已修复** | 浏览器对照。排队后模型清单变化，后续镜头仍按确认时的模型与时长提交。未真实出片。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/src/renderer-v2/features/video-studio/useVideoStudio.ts#L416) |
| R28-5 | P2 | 一次临时读盘失败，会清空作品整理信息 | 仍存在 → **仍存在** | 临时文件对照。一次读取失败后保存另一个字段，仍可能丢掉同一素材的整理信息，影响范围已缩小。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/ai-asset-metadata-store.ts#L358) |
| R28-6 | P2 | 同时添加同一图片的两个副本，会一直发送失败 | 仍存在 → **仍存在** | 离线对照。同一批导入图片副本仍可能保留重复项并阻止发送。应在选择时给出可修正提示。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/ai-chat-attachments.ts#L108) |
| R28-7 | P3 | 重新导入回收站图片，提示成功，但作品库里仍找不到 | 仍存在 → **仍存在** | 临时素材库对照。重新导入不会清除回收状态，界面却提示成功。应能直接在正常列表找到恢复的文件。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/canvas-window.ts#L1229) |

### 10 月 28 日第二批

| 编号 | 旧优先度 | 问题 | 上次 → 本次 | 证据与验收 |
|---|---|---|---|---|
| R2-1 | P2 | 特定视频拼接后，重新出现原片播放时隐藏的开头画面 | 条件性问题仍在 → **已修复** | 浏览器对照。拼接包含特殊时间戳的素材后，原本隐藏的开头没有再出现。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/src/renderer-v2/features/video-studio/timeline.ts#L154) |
| R2-2 | P3 | 损坏的备份被当作不存在，错误原因和删除入口一起消失 | 仍存在 → **仍存在** | 组件对照。损坏备份的记录未显示，原因和删除入口同时消失。应保留可识别的错误行。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/backups.ts#L661) |

### 追加复核

| 编号 | 旧优先度 | 问题 | 上次 → 本次 | 证据与验收 |
|---|---|---|---|---|
| U01 | P2 | 外部配置解析的状态隔离 | 已修复 → **已修复** | 源码复核。外部配置解析的状态隔离仍保留，继续覆盖有效输入和取消。 |
| U02 | P2 | 软件更新安装失败后虽然还留在原界面，但画布再也打不开，需重启管理工具 | 仍存在 → **仍存在** | 源码复核。更新安装失败后的恢复流程仍缺画布。应能回到原界面并再次打开画布。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/main.ts#L3427) |
| U03 | P2 | 测试用浏览器启动失败时，辅助服务没关，测试可能一直不退出 | 仍存在 → **仍存在** | 源码复核。测试浏览器启动失败时辅助服务可能残留。验收失败时也能清理和退出。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/e2e/harness.mjs#L216) |
| U04 | P2 | 使用随包脚本生成/保存图片，上游很慢时，五分钟超时保护会提前失效 | 仍存在 → **已修复** | 源码复核。随包脚本的超时保护已涵盖响应体读取；真实图片服务未调用。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/bundled-skills/xingmang-ai/scripts/generate.mjs#L337) |
| U05 | P2 | 托盘释放内存后，页面恢复若失败一次，后续再打开窗口也不会重试 | 仍存在 → **仍存在** | 离线对照。页面恢复失败后，再次打开窗口仍不发起重试；成功对照能正常打开。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/renderer-release.ts#L165) |
| U06 | P2 | 根目录与画布独立依赖混用 React，开发及验证页面可能无法挂载 | 仍存在 → **部分修复** | 安装和测试对照。按两个锁文件全新安装通过；保留旧画布依赖时部分单测失败，发布客户端无相应事故证据。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/canvas-v2/package.json#L16) |

### 10 月 29 日追加

| 编号 | 旧优先度 | 问题 | 上次 → 本次 | 证据与验收 |
|---|---|---|---|---|
| R29-01 | P2 | 监听恢复后可能漏掉刚发生的 Codex 错误 | 仍存在 → **仍存在** | 临时日志对照。恢复监听期间的错误可能漏报。应能在恢复后补查、避免重复提示。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-payload-limit.ts#L244) |
| R29-02 | P2 | 同一会话切线后再次报错，被去重逻辑吞掉 | 仍存在 → **部分修复** | 离线对照。切线后第二次错误可提示，短暂失败后仍有重试被吞的情况。验收失败恢复后能再处理一次。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/electron/codex-payload-limit.ts#L331) |
| R29-03 | P2 | 切账号或换官方来源后，旧错误处理仍可能迟到生效 | 仍存在 → **仍存在** | 离线对照。旧账号或线路的错误提示可能在上下文变化后才弹出。未证实实际跨账号调用或扣费。 |
| R29-04 | P2 | 补发另一平台时，分批发布限制可能失效 | 仍存在 → **已修复** | 离线规则对照。补发另一平台时，已有分批限制及暂停设置均能保留。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/scripts/release-rollout.cjs#L145) |
| R29-05 | P2 | 某个平台全部升级失败，健康统计仍可能建议扩大发布 | 仍存在 → **部分修复** | 离线规则对照。单平台失败过多能暂停建议；多平台中一个完全缺样本时仍可能建议扩大。应逐平台核对样本。 [实现](https://github.com/xufei5620/xingmang-ai-manager/blob/ca72c2062e6b934cad45af18206db083f2bd3730/scripts/rollout-health.cjs#L157) |
| R29-06 | P2 | 手机遥控开通与后台停用的状态可能不一致 | 仍存在 → **部分修复** | 源码复核。开通入口有保护，连接生命周期与停用状态整体一致性仍待验。未确认停用后执行任务。 |
| R29-07 | P2 | 敏感剪贴板内容的自动清理仍有可靠性缺口 | 仍存在 → **已修复** | 源码复核。原范围内的自动清理责任在失败时已有保障。 |

## 验证记录与边界

11 月 18 日审查时，Windows 本地四段类型检查退出码为 0。对应主分支提交的 CI 通过，含 Windows、macOS、Linux 的相关检查与本地假中转 CLI 冒烟。另有账号普通功能 94 项、媒体单测 152 项通过（另跳过 4 项）、4 个媒体浏览器场景、画布专项 319 项、发布规则 29 项通过（另跳过 1 项）。不同组之间有重叠，本页按组报告。该轮本地没有重新执行整个 `npm test`，原生 Mac、真实 Windows 安装器及线上账本均须单独验收。 [该基线的 CI 记录](https://github.com/xufei5620/xingmang-ai-manager/actions/runs/44069282796)

## 39 条历史补充记录

保留这些编号便于从旧讨论还原当时范围。已纳入本页问题或验收表的项不重复计数。旧版本的验证未重新计作本轮运行。 [原历史索引](../2026-10-28/history-index.md)

| 原编号 | 历史主题 | 本轮处理 |
|---|---|---|
| H-VERSION-01 | 最初版本与当时远端代码差异 | 保留当时版本与验证范围。 |
| H-VERSION-02 | 后续检查范围的变化 | 保留当时版本与验证范围。 |
| H-VERSION-03 | 深审基线及其后增量 | 保留当时版本与验证范围。 |
| H-VERSION-04 | Mac 更新复核的历史快照 | 保留当时版本与验证范围。 |
| H-VERSION-05 | 413 专项的历史代码基线 | 保留当时版本与验证范围。 |
| H-VALIDATION-01 | 初次全套验证与平台限制 | 保留当时版本与验证范围。 |
| H-VALIDATION-02 | 最初 17 项的定向验证 | 保留当时版本与验证范围。 |
| H-VALIDATION-03 | 后续 11 项的筛选范围 | 保留当时版本与验证范围。 |
| H-ENV-01 | 审计环境与开发依赖 | 保留当时版本与验证范围。 |
| H-COVERAGE-01 | 全项目审查覆盖范围 | 基线变化按相关调用链抽查，详见本页开头。 |
| H-VALIDATION-04 | 历史测试工作进程异常 | 保留当时版本与验证范围。 |
| H-VALIDATION-05 | 追加五项的定向与平台验证 | 保留当时版本与验证范围。 |
| H-CHATGPT-IDENTITY | ChatGPT / Codex 桌面产品及平台对应关系 | Windows 和 macOS 分开核对，见桌面安装小节。 |
| H-CHATGPT-PASS-01 | 第一批安装测试与界面对照 | 保留当时版本与验证范围。 |
| H-CHATGPT-OBS-01 | Windows 安装来源与可获得版本 | 源码中仍可能先安装可用的中间版本；尚无失败实证。 |
| H-CHATGPT-OBS-02 | Mac 首次芯片识别失败的后续影响 | 首次识别异常后可能沿用原判断；正确芯片机型须真机验收。 |
| H-F03-SUPPLEMENT | Mac 更新最后阶段的取消 | 见 F03，最后阶段用临时应用验证。 |
| H-F04-SUPPLEMENT | Mac 下载时目标应用升级 | 见 F04；开始时已经装有高版本的对照能阻止替换。 |
| H-VALIDATION-06 | 当时账号退出保护的验证 | 保留当时版本与验证范围。 |
| H-CHATGPT-PASS-02 | 第二批桌面生命周期与界面对照 | 保留当时版本与验证范围。 |
| H-CHATGPT-OBS-03 | 扫描期间打开外部客户端的状态 | 复核了异步检测结构，厂商应用实际运行时行为待验。 |
| H-CHATGPT-OBS-04 | 安装后整轮检查失败的界面反馈 | 安装后整轮扫描失败仍可能影响安装提示，常见自然触发条件待验。 |
| H-ACCOUNT-PASS-01 | 账号异步操作的历史对照 | 保留当时版本与验证范围。 |
| H-N4-SUPPLEMENT | 视频、图片与音频另存的共同保护 | 见 N4，相关另存回归通过。 |
| H-VIDEO-PASS-01 | 历史账号内置视频入口 | 本轮内置服务四个拒绝检查通过。 |
| H-VIDEO-PASS-02 | 两站视频地址与任务归属 | 客户端站点归属已核对；生产路由待服务端证据。 |
| H-VIDEO-TEXT | 分镜规划与视频生成分别记账 | 分镜为文本模型调用；工具密钥配额不能直接代表结算金额。 |
| H-VIDEO-BILLING | 外部视频的最终结算 | 服务器订单与结算待核。 |
| H-VIDEO-EXPLANATION | 订阅、延迟结算与定价的解释范围 | 延迟、订阅与定价均为待核原因。 |
| H-VIDEO-UPSTREAM | 历史站点的实际上游 | 后端当前的上游选择需服务器侧证据。 |
| H-VIDEO-VALIDATION | 历史视频专项的用例范围 | 保留当时版本与验证范围。 |
| H-413-FACT | 历史 HTTP 413 拒绝记录 | 保留当时拒绝记录；本次没有新增现场样本。 |
| H-WS-BEHAVIOR | 旧版 Codex 的传输与回退观察 | 历史观察限当时版本及条件。 |
| H-WS-GAP-01 | 大请求失败发现与切线 | 见本页 WebSocket 验收表第一项。 |
| H-WS-GAP-02 | 配置与会话实际传输 | 见本页 WebSocket 验收表第二项。 |
| H-WS-GAP-03 | WebSocket 与 HTTP 测试覆盖 | 见本页 WebSocket 验收表第三项。 |
| H-WS-LIMITS | 各层当次请求大小上限 | 当时阈值需当时配置和请求记录；客户端代码不能证明。 |
| H-WS-PLAN | 现场恢复验收方案 | 使用授权测试账号核对实际传输方式与完整回复。 |
| H-WS-VALIDATION | 本地配置测试的覆盖边界 | 旧版局部测试，未计入本轮验收。 |
