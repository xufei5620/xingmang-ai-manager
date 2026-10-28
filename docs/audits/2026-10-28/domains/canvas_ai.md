> 统一审查报告的专项附件；固定源码基线为 c21be274，后续新增提交见 [最新增量复核](../latest-delta.md)。本页中的本地证据名称用于维护者对账，关键观察结果已在正文给出；完整受控材料不公开。

# 画布与 AI 执行链统一复核

基线 `c21be2741af6674b2f422d9891b57fc3d2ba5b7b`；当前固定源码基线。本报告确认 **18 个旧问题仍存在，新增 1 个问题 U02**。当前关键代码已经重新阅读；旧复现只在文件内容一致时复用，没有把历史测试说成本轮测试。没有修改产品源码、访问生产、发真实 AI 请求、运行真实安装器或改动用户数据。

## 覆盖与证据边界

- 独占清单 278 文件逐一计算 SHA-256；全部与清单、`ffc04922` 快照一致，另与 `ba916647` 快照逐文件比较也全部一致。当前基线相对 `1b0039c8` 的 6 个变更文件均在其他模块。
- `canvas_ai-coverage.json`（本地受控证据）：157 `reuse-full`（复用上一轮实际完整阅读记录），3 `fresh-full`，1 `fresh-structured`（package-lock），117 `fresh-targeted-test`，0 pending。**清单闭合不等于 278 个文件都在本轮全文阅读。** 关键问题本轮重读区间另记 `fresh_ranges`。
- 117 个测试文件逐文件定向读首末声明、首/中/末断言及首个 mock 摘录；没有声称测试全文覆盖或全部组合场景受测。`canvas_ai-test-structure.json`（本地受控证据） 中的声明/断言次数不是运行用例数。统一 typecheck/npm test 由主审负责，本代理没有重复跑全套。
- 本轮只新增运行 `canvas-update-abort-repro.cjs`（本地受控证据），退出码 0；真实生命周期和画布控制器，当前 main/updater 控制流 AST 提取，安装器和 Electron 原生窗口用 mock，外部调用 0。
- `renderer-v2` 聊天/视频剪辑不在本清单，N2、N7、D02、R28-2/4、负 PTS 导出问题由 renderer 审查归并；本报告不重复计数。R28-6 由本报告跨层归并：补读了相关 renderer 执行入口，并对其与旧夹具基线单独比对 SHA-256。原 #7 启动自动更新打断任务归主审，S04 的安全结论统一列在安全摘要。

## 当前问题与修复验收

### U02 · 新增 P2：安装更新失败后，画布在本次应用会话内无法再打开

**触发/影响**：点击“重启并安装”，退出准备已经完成，但安装器启动抛错，软件留在原进程并显示安装失败。用户再点打开画布，固定报“画布宿主已关闭”；需重启应用才恢复。即使准备更新时没开画布也受影响。此项与原 #7“更新打断正在生成”不同，不推断丢失项目数据。

**当前路径**：[main.ts:2936](https://github.com/xufei5620/xingmang-ai-manager/blob/c21be2741af6674b2f422d9891b57fc3d2ba5b7b/electron/main.ts#L2936) 的 `updateQuitHandoff.prepare` 在 `:2944` 永久 `canvasController.dispose()`；`:2951–2955` 的 abort 仅撤 lifecycle 标志并恢复遥控通知。`canvas-window.ts:1331–1337` 将 disposed=true、销毁窗口、移除 43 个宿主 IPC；`:1296–1297` 此后永久拒绝 open。主入口 `main.ts:2327` 一直引用 `:1952` 创建的同一 const controller。`window-lifecycle.ts:301–305` 只清退出标志。

**真实失败入口**：`bootstrap/updates.ts:221–222` 接到上述 handoff。`updater.ts:1276–1284` 先 prepare 后启动；`:1352` 调安装器；同步失败经 `:1363–1365 → :1255–1265` 调 abort 并恢复 downloaded/failedStep=install。安装 error 事件 `:1535–1542`、安装看门狗 `:1289–1294` 也走 abort；Linux 打开安装器失败 `:1325–1338` 同路。未在真机验证 UAC 拒绝，不把它当本轮动态结果。

**本轮证据**：`canvas-update-abort-result.json`（本地受控证据）：真实 controller/lifecycle 加当前 main handoff、updater requestInstall/launchInstaller/reportInstallFailure 控制流。仅 mock `quitAndInstall` 抛“mock installer launch failure”；更新状态已回 downloaded，isQuitting=false，宿主 IPC 从 43 变 0，再 open 报上述错误且不创建窗口。对照：普通关闭重开成功；新建 controller 后打开成功。零外部调用。

**修复方案**：把“暂时允许退出/关闭窗口”和永久 dispose 分开。准备阶段保留 controller 与 IPC，保存并关闭画布窗口；只有进程确定 will-quit 才 dispose。abort 恢复临时放行标记。若选择重建 controller，须把 opener、账号/主题订阅、事件订阅全部指向新实例并避免重复 IPC；不建议只把 disposed 改回 false。

**验收**：安装器同步抛错、异步 error、启动超时三种离线故障均能继续打开/读写画布；更新前画布打开/未打开各覆盖一次；普通关画布重开与成功退出仍正常；无重复 IPC/订阅，已保存项目内容不变。优先级 P2，高置信度。

### 原 #4 · P1：复制项目提示复用缓存，实际会再次提交生成

**当前状态：仍存在。** 复制有结果的项目后，前端按 succeeded、!dirty、assetId 把节点算作缓存，主进程却按包含新 projectId 的 fingerprint 查询运行缓存；副本只有素材，没有对应缓存。预检 0 个付费请求后，cache miss 仍进入生成器。

**位置**：[pinned-reuse.ts:22](https://github.com/xufei5620/xingmang-ai-manager/blob/c21be2741af6674b2f422d9891b57fc3d2ba5b7b/canvas-v2/src/runtime/pinned-reuse.ts#L22)；`App.tsx:338–348`；`run-preflight.ts:145,201`；`canvas-project-store.ts:406–419`；`canvas-fingerprint.ts:98`；`canvas-run-service.ts:135`；`canvas-run-engine.ts:635–638,690–701`；`RunPreflight.tsx:65,69`。

**复用证据**：`canvas-core-repro-result.json`（本地受控证据） / `canvas-core-repro.cjs`（本地受控证据）：真实 duplicate/store/预检/引擎；副本 paid=0、cacheHit=1，mock 生成 1 次。本轮相关代码及全清单与该快照哈希一致。确认的是远程生成调用超出预检承诺，不推算真实金额。

**修复**：由主进程基于同一执行计划确定哪些结果能复用，并把确认的可付费节点/请求上限随 start 传入。选定资产可作为明确的复用输出；执行期缓存丢失必须停下重新确认，不能越过已确认的 0 请求预算。

**验收**：真实复制项目、缓存淘汰、缓存读失败三种场景，0 付费确认后均无 mock 生成；有效缓存正常复用；用户明确重跑才提交。与 #6 一起设计输出绑定，但保留两项独立验收。

### 原 #5 · P2：剧本解析标成本地处理，遗漏 1–2 次文字模型调用

**当前状态：仍存在。** [run-preflight.ts:5](https://github.com/xufei5620/xingmang-ai-manager/blob/c21be2741af6674b2f422d9891b57fc3d2ba5b7b/canvas-v2/src/runtime/run-preflight.ts#L5) 的付费类型只有图片/视频；`RunPreflight.tsx:65,69` 因而显示本地处理、不显示付费数量。`canvas-node-executors.ts:320,334,340` 首次 completeOnce，格式错误可再请求一次；`bootstrap/ai-services.ts:544–552` 确认接到真实聊天服务。

**证据**：同一`canvas-core-repro-result.json`（本地受控证据），有效格式 1 次、首轮格式无效 2 次，预检 paid=0。未证实每个模型的实际扣费金额。

**修复**：把远程文字步骤纳入付费执行计划，明确格式修正最多再请求一次；区分网络调用与纯本地解析，统一最大请求预算，不在失败时无限重试。

**验收**：首轮有效、首轮格式错、首轮传输失败三种；分别提示并最多调用 1/2/1 次，传输失败不自动再交新单；预检不再显示“本地处理”。

### 原 #6 · P1：选历史图 A，下游实际仍用缓存图 B

**当前状态：仍存在。** 选择 A 只是改变前端 result/adoptedAssetId；生成节点缓存仍按原参数查到最新 B，执行器忽略已选 A。[run-projection.ts:237](https://github.com/xufei5620/xingmang-ai-manager/blob/c21be2741af6674b2f422d9891b57fc3d2ba5b7b/canvas-v2/src/runtime/run-projection.ts#L237)；`App.tsx:257`；`canvas-fingerprint.ts:52–60`；`canvas-run-engine.ts:666–669`。

**证据**：同一`canvas-core-repro-result.json`（本地受控证据），真实候选选择 A，IPC 图含 A，真实引擎下游 mock 视频输入却为 B，运行成功。

**修复**：将“节点已采用的输出”与“是否重新生成的缓存键”分离；下游明确消费已采用的 assetId，并以该输出身份计算下游 fingerprint。不能简单往生成 fingerprint 塞 adoptedAssetId，否则可能使本可复用的节点重生成。

**验收**：同参数生成 A/B 后选 A，图生图和图生视频均使用 A，上游不另付费；切到 B 后输入确实改成 B；资产缺失时明确阻塞而非悄悄回退其他候选。

### 原 #13 · P2：生成中改提示词，旧结果完成后清掉待更新标记

**当前状态：仍存在。** `App.tsx:1663–1711` 只核事件与已登记 run 的 revision，没有核当前编辑输入；成功刷新 `:1567,1586` 直接投影并从 dirty 集合删除；[run-projection.ts:158](https://github.com/xufei5620/xingmang-ai-manager/blob/c21be2741af6674b2f422d9891b57fc3d2ba5b7b/canvas-v2/src/runtime/run-projection.ts#L158) 无条件将成功结果 dirty=false。

**证据**：`canvas-core-repro-result.json`（本地受控证据）：真实执行旧 prompt，等待时改新 prompt，结果完成后新 prompt 仍在、旧图仍被采用、dirty 从 true 变 false，变更运行集合=0。

**修复**：每个提交节点保存输入签名，完成投影时与当前节点和依赖输出比较；旧结果保留到历史，输入已变则保持 dirty。不要因无关节点编辑就把所有成功结果作废。

**验收**：生成中改本节点 prompt/参数/上游引用，旧结果完成后仍待更新；未改输入正常清 dirty；无关节点编辑不影响本节点；后续“仅运行变更”确实包含该节点。

### 原 #14 · P2：复制项目的素材受旧位置缓存牵连

**当前状态：仍存在。** [canvas-project-asset-manager.ts:42](https://github.com/xufei5620/xingmang-ai-manager/blob/c21be2741af6674b2f422d9891b57fc3d2ba5b7b/electron/canvas-project-asset-manager.ts#L42) 位置缓存键只有 user/kind/asset；`:175–178,216–219` 缓存命中后读旧位置失败，不再查其他合法项目。复制项目中确实存在相同内容文件也可能打不开。

**证据**：`canvas-assets-real-copy-repro.log`（本地受控证据）：预热 A 位置，复制 B 后搬走 A 文件，B 的有效副本还在，通用读取失败；新 manager/明确项目读取对照成功。

**修复**：位置缓存是可失效候选；读不到时驱逐并在当前账号合法项目范围重新定位，已知 projectId 时优先该项目。仍须执行 reparse/所有权校验，不可扩大任意路径读取。

**验收**：预热 A→复制 B→移走/删除 A 后，B 预览/生成引用正常；不同账号同 assetId 不串；非法链接仍拒绝；目录真实不可用时给明确错误。

### 原 #15 · P3：小地图、专注模式和面板偏好不保存

**当前状态：仍存在。** [App.tsx:941](https://github.com/xufei5620/xingmang-ai-manager/blob/c21be2741af6674b2f422d9891b57fc3d2ba5b7b/canvas-v2/src/App.tsx#L941)、`:950` 的保存 effect 要求 hydration 标志仍为 true；`:994–1015,3192` 完成初始化后又清掉标志，后续用户切换不进入保存。

**证据**：`canvas-assets-preferences-repro.log`（本地受控证据）：使用真实保存 effect 回调，初始化完成后操作写入次数为 0。库默认折叠是单独的明确产品设计，不列为故障。

**修复**：分清 hydration-in-progress 与 ready；仅恢复初值时跳过保存，准备完成后的用户更改正常写入，并绑定 projectId。

**验收**：切小地图/专注/右面板后重开保持；A/B 项目偏好隔离；首次读到旧偏好不被默认值抢先覆盖；存储不可用不阻塞编辑。

### N4 · P2：另存失败可能已破坏目标原文件（图片、视频、音频同根因）

**当前状态：仍存在。** 选择已存在文件后直接 writeFile 覆盖，写到一半磁盘满才报错，原文件已经截断。[ai-asset-store.ts:831](https://github.com/xufei5620/xingmang-ai-manager/blob/c21be2741af6674b2f422d9891b57fc3d2ba5b7b/electron/ai-asset-store.ts#L831)；`ai-video-asset-store.ts:376`；`ai-audio-asset-store.ts:353`。不声称作品库原资产一起损坏。

**证据**：`chat-save-as-repro.log`（本地受控证据）；`video-store-result.json`（本地受控证据）：注入 partial-write ENOSPC 后，原 31 字节文件剩 16 字节，作品库原片保持；取消对话框、对话框期间切账号对照均未改目标。音频同一写法静态确认，未声称三类都做过本轮运行。

**修复**：同目录临时文件完整写入并安全提交，失败清理临时文件但保留旧目标；检查选择目标的 reparse/硬链接边界，沿现有安全原子写实现收口。

**验收**：三类素材分别注入截断后 ENOSPC/写权限故障，旧目标 hash 不变；成功完整替换；取消/账号变化不写入；目标为危险链接时拒绝。

### D01 · P1：跨项目撤销会把 A 内容写进 B 文件

**当前状态：仍存在。** [App.tsx:1005](https://github.com/xufei5620/xingmang-ai-manager/blob/c21be2741af6674b2f422d9891b57fc3d2ba5b7b/canvas-v2/src/App.tsx#L1005) 把打开 B 当普通 replace-document 命令送进同一 history；`store/history.ts:43–65` 把 A 压栈并可撤回，activeProject 仍为 B；`App.tsx:3206–3207` 将恢复出的 A 图自动保存到 B。

**证据**：`canvas-undo-project-result.json`（本地受控证据）：标题 B，撤销后节点来自 A，从真实 store 重开 B 也读到 A 内容，原 B 节点消失。不是只有界面显示错，也不扩大为跨账号泄露。

**修复**：新增不入历史的 open/resetDocument(projectId,document) 生命周期操作；切项目清空或按项目分开历史、runtime 和 pending 保存。保存闭包捕获项目 ID，切换后不得将旧文档写新项目。

**验收**：A 编辑→中心→B→撤销，不可回到 A；B 的磁盘内容保持；B 自己的修改可以撤销；快速切换与待保存状态也隔离。与 F02 可共用生命周期修复，验收分别保留。

### D03 · P2：便签里的网址、路径或 TODO 保存后消失

**当前状态：仍存在。** 普通便签的 `settings.text` 被当可执行/路径设置清洗。[workflow-schema.ts:170](https://github.com/xufei5620/xingmang-ai-manager/blob/c21be2741af6674b2f422d9891b57fc3d2ba5b7b/canvas-v2/src/persistence/workflow-schema.ts#L170) 拒绝协议样式、盘符或斜杠开头；`workflow-sanitizer.ts:32–43,118` 遇嵌入 https 也删整段，保存仍成功且无警告。

**证据**：`canvas-note-roundtrip-result.json`（本地受控证据）：普通中文对照保留；链接、TODO、Windows 路径、/imagine 四类变空。主进程项目包校验对这些 prose 原本允许。

**修复**：对明确的 note.text 等纯文字字段使用有长度限制的文本规则；其他凭据、路径和未知设置仍按原安全规则过滤，不能整体放开 sanitizer。

**验收**：上述五类文字（含链接周围说明）经自动保存、手动导出/导入与重开保持一致；敏感/未知字段仍不进入导出；发生过滤时不默默报保存成功。

### D06 · P2：“保留全部输入”实际只传第一张参考图

**当前状态：仍存在。** 正式 UI `WorkflowNodes.tsx:823–833` 有 all，但 `App.tsx:235–275` 不发送 strategy；路由执行器返回多候选，最终 [canvas-run-engine.ts:745](https://github.com/xufei5620/xingmang-ai-manager/blob/c21be2741af6674b2f422d9891b57fc3d2ba5b7b/electron/canvas-run-engine.ts#L745) 只记录 candidates[0] 作输出。当前支持的是单输出链，没有把该 UI 意图交到主进程。

**证据**：`canvas-router-all-result.json`（本地受控证据）：A/B 两合法参考输入，all 模式成功运行，mock 编辑请求只有 A。显式发送未来 routerStrategy 字段会被拒绝，但现 UI 不发送，因此这道防护不拦该场景。

**修复**：统一策略契约、投影、解析和多输出输入收集，all 把完整有序资产传到下游；若暂不支持，界面禁用该选项并在付费前明确阻塞，不能继续假装成功。

**验收**：all 的下游 sourceAssetIds 为 A/B；first-available 为 A；上游缺失时行为明确；未知策略付费前拒绝。不能只改下拉框文字。

### D07 · P2：短剧跨类别相同 ID 将人物、场景接成道具

**当前状态：仍存在。** AI 回答每类都从 elementId=1 开始会通过前后端表内校验；[drama-layout.ts:68](https://github.com/xufei5620/xingmang-ai-manager/blob/c21be2741af6674b2f422d9891b57fc3d2ba5b7b/canvas-v2/src/library/drama-layout.ts#L68)、`:84,99,113` 共用原始 ID Map，后写道具覆盖人物/场景，`:128–134` 无类别查引用。两份 drama-parse `:192–195` 都只检查表内唯一。

**证据**：`canvas-drama-id-collision-result.json`（本地受控证据）：三类编号 1，默认确认后参考都指向钥匙，编译提示词漏人物和场景；改为 char-1/scene-1/prop-1 的对照正确。模型真实出现频率未验证。

**修复**：使用“类别+ID”复合键并按引用类别解析；若规范必须全局唯一，应在铺图前显式校验并阻止，而非静默覆盖。格式修正产生的远程次数与 #5 同一预算控制。

**验收**：三类同 ID 正确连各自资产，表内重复拒绝，缺失引用拒绝；确认框、图中边、最终生成提示词三处一致。

### D08 · P2：当前选中素材与详情操作对象不一致

**当前状态：仍存在。** A 单选→Ctrl 加选 B→Ctrl 取消 B 后，selected 只剩 A，anchor 仍是 B；[asset-selection.ts:35](https://github.com/xufei5620/xingmang-ai-manager/blob/c21be2741af6674b2f422d9891b57fc3d2ba5b7b/canvas-v2/src/components/asset-selection.ts#L35) 优先 anchor 选详情，`:59` 移除选择未修 anchor。用户会给未选中的 B 改名等。

**证据**：`canvas-asset-selection-evidence.json`（本地受控证据），选中集合与 detail ID 不同；不是仅颜色样式问题。

**修复**：单选详情从 selected 集合取唯一 ID；移除 anchor 时规范重置，同时保留 shift 连选所需锚点的独立语义。

**验收**：上述选择序列，显示名称、改名、标签操作和删除目标都为 A；Ctrl/Meta、Shift 连选、全取消均覆盖。

### D09 · P2：原图和缩略图都失效时反复请求

**当前状态：仍存在。** [MediaPreview.tsx:24](https://github.com/xufei5620/xingmang-ai-manager/blob/c21be2741af6674b2f422d9891b57fc3d2ba5b7b/canvas-v2/src/components/MediaPreview.tsx#L24) 只记最后一个失败地址；`:31,41` 缩略图失败后回到原图、原图失败又回缩略图，错误状态反复循环。

**证据**：`canvas-safe-image-evidence.json`（本地受控证据）：有界观察到 8 次交替失败后由测试停止，真实代码无终止条件。发生在两个来源都坏时，不描述正常素材也循环。

**修复**：为当前 source/fallback 对维护失败集合或明确 primary→fallback→failed 状态机；只有输入来源变化才清空失败状态。

**验收**：双失败最多各尝试一次然后稳定占位；主图成功 1 次、备用成功最多 2 次；换素材可以重新尝试；卸载后无重试。

### D10 · P2：AI 被截断或过滤，仍被标成正常完成

**当前状态：仍存在。** [ai-chat-service.ts:557](https://github.com/xufei5620/xingmang-ai-manager/blob/c21be2741af6674b2f422d9891b57fc3d2ba5b7b/electron/ai-chat-service.ts#L557) 把所有 finish_reason 压成 finished 布尔值；`:732–751,796–818` 一律 complete，不保留 length/content_filter；`:1035–1058` completeOnce 也会返回不完整文本。

**证据**：`network-chat-finish-repro.json`（本地受控证据）：length 半句和 content_filter 空白都产生 complete，无原因字段。普通 stop 是对照。

**修复**：保留并传递终止原因；length 展示“达到输出上限，回答未完整”，content_filter 明确失败/受限原因并保留允许返回的文字；completeOnce 对要求完整结构的调用返回结构化不完整结果。不要为了提示完整就自动再发付费请求。

**验收**：stop、length、content_filter、无结束标记断流，流式与一次性分别验证；界面不把半句当完整，原文字不丢；续写需明确用户动作。

### F02 · P2：切到同节点 ID 的副本会继承 A 的生成状态和候选图

**当前状态：仍存在。** `use-canvas-document.ts:27–30,103–108` 把 runtime 放独立 map；[use-canvas-document.ts:154](https://github.com/xufei5620/xingmang-ai-manager/blob/c21be2741af6674b2f422d9891b57fc3d2ba5b7b/canvas-v2/src/store/use-canvas-document.ts#L154) 按 nodeId 合并；切项目 `App.tsx:997–1015,2950–2974` 未清 runtime。副本沿用 nodeId，导致 B 接到 A 的状态/候选。

**证据**：`canvas-findings.md`（本地受控证据）：A 完成后切同 ID 副本、A 运行中切副本均复现；不同 nodeId 对照正常。主进程 run 仍归 A，B run 记录为 0；**B 的 prompt/result 未被覆盖，candidateAssetIds 会随 B 保存**。重开 B 后运行态归 idle。不要混成 D01 的整图覆盖或额外扣费。

**修复**：runtime、事件和投影均绑定 projectId/runId；切文档重置运行态，后台 A 任务可继续但不得投到 B。非当前项目候选不可进入 B 的持久化快照。

**验收**：完成、运行中、不同 ID 三组真实 UI/store 对照；B 不受 A busy 阻塞，不出现 A 候选、不保存 A candidate IDs；回 A 仍可查看 A 的真实任务。

### R28-5 · P2：一次读盘 EIO 被当成损坏并以空素材元数据表继续保存

**当前状态：仍存在。** [ai-asset-metadata-store.ts:430](https://github.com/xufei5620/xingmang-ai-manager/blob/c21be2741af6674b2f422d9891b57fc3d2ba5b7b/electron/ai-asset-metadata-store.ts#L430) 的 readState 把普通 IO 故障和损坏混为一类；`:441–450` 备份原文件并返回空表，`:273–299,379–400` 后续操作保存空表。名称、标签、收藏和回收站标记丢失，已删素材可能重新可见；备份仍在，不能描述为无法恢复的文件内容丢失。

**证据**：`media-metadata-read-failure-repro.log`（本地受控证据）：原 2 条记录经一次读取故障消失，后续保存新空状态。

**修复**：仅 ENOENT 才按首次创建；其他 IO 错误必须阻止后续写。格式损坏保留原文件/备份并明确进入恢复流程，不自动假定空库等于成功。

**验收**：单次 EIO 后源 hash 不变、操作报错，再读恢复 2 条；ENOENT 正常新建；坏 JSON 给明确恢复状态；收藏与回收站字段不因失败丢失。

### R28-6 · P2：一次选入同图的两个副本，消息无法发送

**当前状态：仍存在。** 用户在“加图片”里一次选两个不同文件名、内容相同的文件，草稿出现两个相同资产 ID。点发送被协议拒绝，重试仍然失败；点其中一张移除，两张一起消失。错误在远程请求发出前发生，**该场景不会因此产生一次 AI 调用或扣费**。不是字幕/caption 数量不匹配。

**当前路径**：`electron/ai-chat-attachments.ts:85–106` 按文件返回每个存储结果；`ai-asset-store.ts:656–659,881–883` 的内容寻址使同内容返回同 assetId，这是正确的存储去重。[state.ts:392](https://github.com/xufei5620/xingmang-ai-manager/blob/c21be2741af6674b2f422d9891b57fc3d2ba5b7b/src/renderer-v2/features/chat/state.ts#L392) 的 `addDraftImages` 只与已有 draftImages 比较，未去掉本批内部重复。`useChatController.ts:348–350` 整批进入该函数；发送 `:255–264` 调协议校验，`electron/ai-chat-protocol.ts:645` 拒绝重复图片 ID，原始错误 `message images repeat` 被 `state.ts:378` 转成笼统重试提示。`state.ts:399–402` 按 ID 移除，因此两个副本一起消失。主要修复点在 renderer 草稿合并；主进程内容去重及协议拒绝本身不是错误。

**证据与复用边界**：`media-normal-operations-repro.cjs`（本地受控证据） 与 `media-normal-operations-repro.log`（本地受控证据）：同批 2 个附件、1 个唯一 ID，实际 validateChatRequest 失败；同两张图分两次添加则 1 个附件、校验通过。使用临时 PNG、离线文件选择和禁止外部调用，没有浏览器端到端或真实发送。本轮重新读上述代码；attachments/protocol/asset-store/state/api/useChatController/ChatPage 共 7 文件 SHA-256 均与该夹具的 `1b0039c8` 已验证快照相同，故复用原结果，未重跑全套。

**修复**：`addDraftImages` 用已有 ID 初始化 Set，按顺序遍历本批并在接纳时立即加入 Set；上限按最终唯一附件数计算，保留第一份顺序。附件服务可防御性返回唯一资产列表，但不能只修主进程而遗漏其他草稿入口。保留协议对重复 ID 的校验，不以放宽协议掩盖错误。

**验收**：同批两份同内容不同名→草稿只 1 张且可通过发送校验；分批重复→仍 1 张；两份不同内容→正常 2 张；已有草稿与新批混合重复时顺序、唯一数和上限正确；移除只移除当前唯一附件；校验失败不触发 AI 网络调用。

### R28-7 · P3：重新导入回收站同一文件显示成功，作品库仍不可见

**当前状态：仍存在。** 导入内容去重复用 assetId；[canvas-window.ts:911](https://github.com/xufei5620/xingmang-ai-manager/blob/c21be2741af6674b2f422d9891b57fc3d2ba5b7b/electron/canvas-window.ts#L911) 到 `:956` 只 setSource；`ai-asset-metadata-store.ts:379–394` 保留 deletedAt；`ai-media-asset-service.ts:158` 仍把它过滤掉。

**证据**：`media-normal-operations-repro.log`（本地受控证据）：导入→删除→再导入同文件，返回成功且同 ID，但普通列表 0、回收站 1；显式恢复对照可见且原标签/收藏还在。不是文件被物理删除。

**修复**：显式导入遇到回收站同 assetId 时恢复它并保留已整理元数据，或明确提示“已在回收站”并给恢复入口；不能假报正常导入完成。

**验收**：同文件重导可见、回收站无重复，名称标签收藏保留；不同内容正常导入；已存在正常素材不增重复项。

## 计费与跨站路由的反证边界

本轮重读 `bootstrap/ai-services.ts:166–173,498–529`、`ai-video-service.ts:555–595,630–641,730–760,843–918` 及完整 `chat-credential-coordinator.ts`：视频服务由账号 realm 的 `definition.aiBaseUrl` 建立，两类视频 task store 各在 realm 数据根目录。历史 `solov-api` 的两份 generate/resumeVideoTask 均被明确拒绝；没有发现失败后改向 xm 生成的客户端分支。恢复 request/task 是已有任务的 GET 查询/下载，不是再次 POST。下载签名 CDN 不带 API Key；内容 fallback 仍回当前服务 baseUrl。

同 realm 同 user 的身份检查与 coordinator 当前站点检查仍在。`canvas-window.ts:447–455` 的 accountWork 门控和 `main.ts:1702–1721` 的切账号 quiesce/等待，使“导入失败回滚串到新账号”的候选缺乏实际可达证据，本轮不列缺陷。共享上游再次运行前已明确确认 2 个付费步骤的情况也不单凭两次 mock 调用判重复扣费。

历史专门验证见 `video-client-realm-review.md`（本地受控证据） 与 `account-video-realm-result.json`（本地受控证据）。历史正常 UI 视频页连“写分镜”也不可用的页面结论由 renderer 审查确认；底层 plan 是独立文字请求，不能据此说任何底层调用都免费。以上仅客户端保护与离线证据，**不证明服务器实际扣费正确，也不等于已验证生产模型可用**。

## 建议实施顺序

先修 D01 项目数据覆盖、原 #4/#6 的执行计划与采用输出一致性、N4 原子另存；随后处理 U02 更新失败恢复、原 #5 远程请求预算及 #13/F02 项目/运行版本绑定。剩余问题按各自边界补定向用例，不用“原单测全绿”替代上述反例验收。产品改动需要另行实施，本次只交审查与修复方案。
