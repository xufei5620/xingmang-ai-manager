> 统一审查报告的专项附件；固定源码基线为 c21be274，后续新增提交见 [最新增量复核](../latest-delta.md)。本页中的本地证据名称用于维护者对账，关键观察结果已在正文给出；完整受控材料不公开。

# renderer-v2 当前基线复核与修复建议

基线：`c21be2741af6674b2f422d9891b57fc3d2ba5b7b`，固定审查基线。本报告只读审查，不含产品修改。2026-10-28 新发现远端 `444ecc18` 的视频修改另见 `../latest-delta.md`；下文状态先严格对应 c21。

473 个清单文件全部校验 SHA256，均与父清单相符，也均与已验证 `source-1b0039c8-verified` 字节一致。覆盖台账为 `renderer-coverage.json`：268 个复用旧全文审读、29 个本轮全文审读、2 个旧全文加本轮完整差异审读、174 个本轮支持文件定向审读，pending 为 0。174 个主要是单测/浏览器脚本/测试装配；台账记录实际阅读范围，**不代表本轮全文重读全部 473 文件，也不代表执行了全部测试**。支持测试索引见 `renderer-support-map.json`。未扩展到冻结 legacy 的一般缺陷。

本轮新增 1 个已确认问题 U01。旧证据复用均有当前哈希及当前调用链复核；没有把旧浏览器运行冒充本轮新运行。主进程跨域问题只记录前端可达性，最终状态由对应主审合并。下文renderer 路径相对于上述基线的 src/renderer-v2，electron 路径相对于仓库根。

## U01

此安全条目已纳入 [公开状态与验收目标](../security-status.md)。详细触发条件、定位与受控复现保留本地，按仓库安全策略不随公开 PR 发布。

## 旧问题：当前仍成立的 renderer 责任项

### #16 · P2 · / 搜索键选中了缓存中的隐藏页面

**状态：confirmed/reuse。** `features/shell/Shell.tsx:285–298`，特别 `292`，在整个 viewport 中选第一个搜索框；`App.tsx:483` 缓存页面通过 hidden/inert 隐藏而不卸载。先访问会话，再进 MCP，按 `/` 会选中隐藏会话搜索框，阻止默认输入后仍未聚焦当前 MCP。旧原组件证据 `本地证据/renderer-slash-evidence.json`；本轮复核当前选择器和页面保活链仍在。

修复：搜索限制到当前活动页面，排除 hidden/inert/不可见祖先；确有可聚焦目标时才 preventDefault。验收：会话→MCP 与反向导航均聚焦当前框；输入框、弹窗、IME 场景不抢键。

### N2 · P1 · 视频提交结果未知，重开后误变成“还没生成”

**状态：confirmed/reuse，c21；最新提交需看独立差异报告。** `features/video-studio/project.ts:269` 的保存投影与 `useVideoStudio.ts:85–88` 的无任务恢复分支，会清掉未知提交状态/请求号并回 idle；服务端已接收、客户端未收到任务号时 `ai-video-service.ts:762` 尚无可恢复的任务记录。原浏览器及原主进程 mock 证明重开后可再次提交，存在重复费用风险，未验证生产扣款。

证据：`本地证据/video-ambiguous-browser-result.json`、`video-ambiguous-submission-result.json`、`video-new-finding.md`。

修复：提交前持久化请求号和“结果未知”；把“本地查不到记录”与“确认未提交”分开，未知结果不得自动恢复成可重提；服务端支持时绑定幂等请求。验收：服务端接受但回包丢失，重开仍提示未知且保留请求号；空恢复结果不得清除此状态；用户明确确认重试及正常完成恢复分别测试。

### N3 · P2 · 订阅确认框保留旧价格，提交未校验确认价

**状态：confirmed/reuse。** `features/account/AccountRecharge.tsx:272,509,571,998` 保存旧 plan 对象，列表更新不使确认失效；请求 `electron/new-api-client.ts:3632` 只有 plan_id。旧原组件 mock 中卡片刷新为 20，确认框仍为 2，模拟服务端按新版扣 20。结论是价格展示/提交一致性缺口，**没有验证生产实际扣款**。

证据：`本地证据/recharge-price-evidence.json`。修复：价格/币种/套餐版本变化时废弃确认并要求重新确认；由服务端原子校验 quote 或 expected price/version，不能只在 UI 改数字。验收：2→20、套餐下架、币种改变均不得凭旧确认提交；未变化时正常提交。

### N7 · P2 · 长聊天会错误拦住一条短生图请求

**状态：confirmed/reuse。** `features/chat/state.ts:326` 无条件校验全部历史，而 `useChatController.ts:262` 的生图实际只发送当前 prompt/sourceIds。历史达到限制后即使短生图也被拒绝。

证据：`本地证据/chat-image-history-limit.log`（100 条旧消息生图请求为 0，新对话对照正常）。修复：按实际请求种类验证文本上下文或生图 prompt/参考图，不使用不发送的历史限制图片。验收：长历史+短图片描述恰好发一次图片请求；文本超限与生图自身超限仍拒绝。

### N11 · P3 · 点“先不打开”也会完成新手引导

**状态：confirmed/reuse。** `features/tools/useToolLaunch.ts:239–252` 忽略原生 declined，只以请求仍有效作为成功；`features/auth/StartGuide.tsx:523–524` 据此完成引导。文件夹取消的对照返回 false，原生 declined 却返回 true。

证据：`本地证据/renderer-launch-ui-evidence.json`。修复：明确 launched/cancelled/declined 结果并把拒绝返回未完成。验收：文件夹取消和原生 declined 均不持久化引导完成；真正打开才完成。

### D02 · P2 · 导入超出 50 条时静默删除已有聊天

**状态：confirmed/reuse。** `features/chat/storage.ts:386–397`，特别 `391–393`，合并后排序并截为 50；`SettingsPage.tsx:377–389,1355–1383` 没有聊天裁剪确认。真实 history 保存 `electron/ai-chat-history-store.ts:145–149` 会删除不在列表的文件。50+1 导入既有文件被真实临时 store 删除，不能仅称显示少了一条。

证据：`本地证据/renderer-chat-import-evidence.json`。修复：写入前预检容量，超限拒绝整体导入且保持旧记录；如产品要允许替换，必须明确展示删除清单并先备份。验收：50+1、49+2 不静默写/删；49+1 正常；失败后原文件不变。当前 storage 测试“keeps every conversation past limit”测试的是单条会话合并，不覆盖此导入函数，不能据此标已修。

### D11 · P2 · 七日用量写进别的账号的持久缓存

**状态：confirmed/reuse。** `features/tools/week-spend.ts:116–120` 取会话 A，`131` 后续 dashboard 没带 expectedScope，`135–137` 按先前 A 的 key 写缓存；`157–158` 失效不保护这个内部写盘。切 B 后返回的 B 用量可以永久缓存到 A，换回、重开仍错误。

证据：`本地证据/accounts-renderer-extra-repro.output.json`，真实 handlers/gate 的离线交错，A 恢复后出现 B 的六天 900。未影响实际计费，只影响展示。修复：请求全链绑定 expectedScope，写持久缓存前检查同一账号 epoch；invalidate 要作废内部运行代次。验收：延迟 A 会话结果→切 B，A 缓存不得写入 B 日用量；重开仍正确，正常历史缓存继续有效。

### D24 · P3 · 主题导入短暂成功，重新打开又变回旧主题

**状态：confirmed/reuse。** `SettingsPage.tsx:377–389` 只更新 AppSettings，主题手动控制却在 `552–558` 走平台 themePreference；`platform-api.ts:35–44,57–60` 再绑定时覆盖显示。旧 mock 证实导入 dark 后 DOM dark，但选择项仍 light，平台设置写入为 0，重绑后 light。

证据：`本地证据/renderer-theme-evidence.json`。修复：导入统一调用真正主题 setter，导出使用实际 preference（含 system），处理部分写失败。验收：导入后的 DOM、选项、持久设置、重启一致；system 保留；平台写失败不能报告全部导入成功。

### D27 · P3 · 大小写不同的目录少一个续聊入口

**状态：confirmed/reuse，限定区分大小写文件系统。** `features/tools/recent-workspaces.ts:69,131` 无平台区分地小写化路径，`146–152,179–180` 合并续聊。Linux `/work/Foo` 与 `/work/foo` 合并，旧项目入口消失；聊天文件没有被删除。

证据：同上 `accounts-renderer-extra-repro.output.json` 的目录对照。修复：采用文件系统/平台合适的路径身份规则，POSIX 不盲目折叠大小写；Windows 现有行为保留。验收：Linux 两目录分开、Windows 同路径不同大小写仍去重；macOS 大小写敏感卷也纳入规则。Linux 当前发布受开关限制，不扩大成全部 Windows 用户问题。

### F05 · P2 · 更新期间开另一个工具，Codex 不再自动重开

**状态：confirmed/reuse。** `App.tsx:289`→`features/tools/useDesktopAppUpdate.ts:104`→`useToolLaunch.ts:286–292`，`291` 在另一次启动 pending 时直接返回，自动重开请求丢失。Mac 更新已关闭 Codex，期间打开 Claude 并等待配置，更新结束不会重开 Codex；Claude 完成也不补发。手动可重开，无数据损失证明。

证据：`本地证据/desktop-ui-evidence.json`；更新独立运行对照重开 1 次。修复：自动重开进入可等待队列并保持账号 epoch，不能套用按钮双击直接忽略逻辑。验收：交错后在前次启动结束时恰好重开一次，换号不错误沿用旧任务，更新失败回退规则保持。

### R28-1 · P2 · 星芒安装源有新版，Windows 首页仍无更新入口

**状态：confirmed/reuse。** `features/tools/model.ts:396–402,435–436` 只依据第三方镜像可更新；`Home.tsx:581,895–899` 因而无更新入口。已装 A=26.1001.1.0，官方和星芒桶 B=26.1002.1.0，第三方还为 A 或失败时被挡；实际安装原服务从星芒桶取得 B，证明有可用安装源。第三方为 B 对照有按钮。

证据：`本地证据/renderer-desktop-source-evidence.json`、`chatgpt-windows-result.json`（假包、部署 mock，无真安装）。修复：检查和安装共享所有批准来源的候选版本与来源，UI 据“实际可安装新版”决定；不能仅按官方最新版放开而无可下载包。验收：桶新版+镜像旧/失败均能更新，所有可用源都无新版时不误提示；卡片、角标、实际安装版本一致。

### R28-2 · P2 · 导入时进入聊天，旧自动保存删掉刚导入的记录

**状态：confirmed/reuse。** `features/chat/transfer.ts:31–35` 只在 await 前卸载一次；`App.tsx:390–393` 与 `features/app/useAppNavigation.ts:95` 允许重新进入；旧 controller 随后通过 `storage.ts:439–444` 写旧列表。1+1 也发生，与 D02 的 50 条容量问题不同。

证据：`本地证据/renderer-import-race-evidence.json`，原 App+真实临时 history：导入显示成功、文件有 2 条，输入草稿后变回 1 条且导入文件被删；等待导入后进聊天对照保留 2 条。修复：同账号导入事务期间阻止旧控制器重新加载/写入，提交后强制按新 revision 重载；持久层版本校验/合并提供兜底。验收：分别暂停读取、写入时导航并输入，完成和重开后均保留 2 条；取消/失败解锁，账号隔离。

### R28-3 · P2 · 工具检测没完成就切账号，默认配置同步被遗漏

**状态：confirmed/reuse。** `SavedAccounts.tsx:67–68` 无检测数据时候选为空，`180,187–192` 切换按钮不等 loaded；`account-switch-sync.ts:190–191,204,217` 空选择直接完成账号切换，不同步 CLI。正常加载对照写 3 个工具，延迟检测场景写 0 个。

证据：`本地证据/accounts-slow-switch-result.json`。修复：默认同步路径等待检测完成或明确禁用切换；检测失败给重试，若支持“只切账号”应为用户明确选项而非空数据隐式结果。验收：延迟检测不能静默按空列表切换；完成后默认工具确实同步；显式取消全选仍被尊重。

### R28-4 · P2 · 批量视频确认后，排队镜头偷偷换模型和时长

**状态：confirmed/reuse，c21；新提交另查。** `features/video-studio/VideoStudioPage.tsx:158,201–202` 确认模型和时长，`useVideoStudio.ts:126,138–164` 迟到 catalog 改 settings，`253,267,276` 队列只保存镜头 ID、出队时再读当前参数；`project.ts:132,141,199` 回落到其他模型/秒数。确认 4 段 Grok 3 秒，前三段开始后目录移除 Grok，第四段成为 MiniMax 5 秒，无二次确认。

证据：`本地证据/video-model-changed-during-result.json`、`video-model-unchanged-during-result.json`、`video-model-changed-before-result.json`、`video-model-main-replay-result.json`；原主进程 mock POST 也确实是 MiniMax 5 秒，未生产生成或计费。修复：每批队列保存不可变确认参数；模型失效停止并重新确认，不静默 fallback。验收：三个对照重跑，第四段须保持已确认参数或明确阻止等待重确认。

### 第二轮-2 · P3 · 损坏备份被隐藏，不能在界面删除

**状态：confirmed/reuse。** `features/settings/BackupCard.tsx:140–142` 只保留 active provider，实际坏清单返回 provider=null/valid=false 被过滤；组件原本 `213–224,252` 有无效项禁恢复、删记录和错误展示。归因与 Gemini 退役不矛盾：只该排除明确 Gemini，不该排除未知归属的坏记录。

证据：`本地证据/backups-visibility-result.json`，原 App+真实 ConfigBackupStore：有效时 1 行/有删除按钮，截断清单后 0 行并提示没有备份，目录仍存在。修复：全部列表保留 provider=null 的无效项，显示原因和删除，禁止恢复；Gemini 继续按退役政策过滤。验收：损坏项可见、可删、不可恢复，有效项和 Gemini 对照不回归。未证明备份数据被删除。

### 第二轮-1 · 条件性 P2 · 部分带负时间戳视频导出出现前导画面/声音延迟

**状态：confirmed/reuse。** `features/video-studio/compose.ts:96,129`、`timeline.ts:119` 以含负 PTS 的首帧作为拼接时间基点。有效测试 MP4 含 -0.25 秒隐藏前导红画面，原生播放器 0.1 秒为蓝画面并有声音，原组件 AVC/AAC 导出 0.1 秒仍红、声音迟到；并非所有视频。

证据：`本地证据/video-negative-pts-page-result.json`、`video-timestamp-result.json`。修复：采用有效呈现区间裁去负时间戳前导帧，音视频共享归一化原点，保持有意的正向裁剪。验收：原复现 0.1 秒蓝画面且有声音；零起点、延迟音轨、+5 秒时间戳三个对照维持正确。没有验证生产供应商此素材比例。

## 已修复、跨域合并与观察项

- **#9 扩展慢操作串工具列表：fixed。** `features/extensions/ExtensionsPage.tsx:301–304` 以 layoutEffect 更新 shownProvider，统一 reloadList 检查当前 provider；当前添加、删除、认证、安装回调都经此路径。操作提示在 `180–195` 同样归属当前工具，健康检查 `690` 有守卫。复用 ba916647 旧修复证据，加本轮 1762 行完整阅读；未把“旧代码已删”当唯一依据。
- **N5 启动账号隔离：renderer 可达，合并主进程最终状态。** `features/tools/useToolLaunch.ts:239` 等待启动中仍可切账号，当前 `electron/ipc/handlers/launch.ts:329` 的工作区 await 早于 `229` 的 account capture。旧真实队列证明 A 请求实际用 B 配置，证据 extra-audit 的 `renderer-launch-main-evidence.json`、`renderer-launch-ui-evidence.json`。修复需 IPC 入口捕获 epoch，所有入队前 await 和队列执行前复核；验收延迟 A 路径检查后切 B 不得启动，A 正常对照仍启动。前端 spinner 不是后端隔离兜底。
- **F03 Mac 已接受取消仍替换：renderer 可达，合并主进程条目。** `features/tools/useDesktopAppUpdate.ts:85–88`、`useToolbox.ts:264–269`、`Home.tsx:958–959,1012–1013` 在实际 installing 阶段仍提供取消，旧 UI 及真实临时 bundle 证据成立。修复要定义最终提交屏障：屏障前接受取消则不得替换，屏障后应明确拒绝取消并展示正在完成。不要另列第二个“UI 可点取消”问题。
- **N6、D13、D23、D25：** 相关 renderer 入口未改，根因和最终状态由账号、会话、更新、AI 主进程责任人合并；没有单独新增计数。N1/N8 的主进程在 c21 与 1b 间有修改，不能仅凭 renderer 同哈希把旧结论直接标仍存在。
- **R28-6 同批图片重复 ID：confirmed/reuse，由 canvas_ai 跨层合并。** 根因是 `features/chat/state.ts:392–402` 的 addDraftImages 只对旧草稿去重，漏掉同批内部重复；主进程内容去重本身正常，`useChatController.ts:255–264,348–350` 发送重复 ID 后协议报 message images repeat。修复是在 renderer 按 assetId 稳定去重整批（可选主进程附件结果防御去重），保留协议拒绝。验收：同批两份同内容图片只保留一个 ID 且可发送，分批同内容、不同内容及上限对照正常。现有 1b 复现与当前相关 7 文件 SHA 一致，详见 canvas_ai.md。
- **桌面生命周期原验证复用：** round2 `renderer-lifecycle-report.md` 及其 3 组证据，10 个正常场景覆盖安装离页保活、取消接受/拒绝/失败重试、安装/重置/卸载失败重试、配置准备失败不误报成功、共享修复忙态、启动中导航防双开。当前相关 renderer 与 1b 同哈希。另 1 个人工让整个 scanSystem 抛错的观察没有可证明的常见自然触发，**不计缺陷**，本轮未重跑该 10+1。
- 任务列表未自动轮询、未验证的粘贴预填残留/Unicode 异常等候选不计新问题。没有拿任意 mock 抛错当真实触发链。

## 本轮验证与交付边界

- SHA256 核验 473/473；覆盖台账 473/473，pending=0，各 review_level 按实际工作记录。
- 新执行的 U01 浏览器 2 场景成功；全部原生能力隔离 mock，外网请求为 0。没有真实账号、账单、模型生成、安装、重置或配置写入。
- 旧 browser/main mock 证据均明确 reuse；未重复运行全量 npm，统一回归由主审负责。本报告不把静态阅读等同于线上验证或所有平台真机测试。
- 产品工作区未写；报告、harness、JSON 和 Vite 缓存均在临时输出目录。后续最新视频提交差异不覆盖此 c21 原始台账，另存报告和 blob 哈希。
