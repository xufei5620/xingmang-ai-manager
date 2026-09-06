# 15 · UI契约与G01–G19对照矩阵 v3.0

本表将[12固定源码核对](12-github-code-review.md)的G01–G19映射到本轮原型和后续实现。固定源码基线为GitHub `0c9ec4a5a3c9cf31fa0e05c33725cd31ae73e39e` / package `0.1.31`；本轮模块静态读取只证明UI模拟代码存在。通过数量和运行证据统一见[16最终验证](16-final-validation.md)，不将每行默认填成“已真实验证”。

**代码已有**指12中的产品证据；**本轮设计**包括对齐已有功能与新增UI交互；**真实接入**是适配接口、IPC、文件与原生能力时的工程约束。没有真实后端不是离线原型缺陷，模拟成功也不能代替真实服务结果。事件与字段是UI契约，不虚构API端点。

## 1. G01–G19主矩阵

| G编号 | 固定代码事实 | 本轮模块、UI入口与状态 | 实现时保持的契约 | 验收映射 |
|---|---|---|---|---|
| G01 首次主线 | 桌面端是初始化主线，Node/npm/CLI可选；检测/外部安装/官方来源有条件分支 | 10欢迎与准备四步；40安装/配置；50平台分流。Windows/macOS桌面优先，Linux走CLI/聊天；检测、安装、连接失败留当前步 | 以检测结果和用户选择驱动；“我已安装”只触发重新检测；保留曾卸载与来源信息，不自动重装/覆盖unknown | J02/J03/J04/T05 |
| G02 注册自动登录 | 注册后尝试自动登录，失败预填用户名回登录 | 10的登录/注册及初始化；20的XM.authComplete绑定新账号。成功进入准备，自动登录失败可重试 | 账号创建、登录、初始化分开记结果；不无条件承诺已生成所有Key，部分准备失败列明对象 | J01/J05 |
| G03 来源与启动条件 | ChatGPT/Claude/Google官方来源；Grok无官方登录；unknown独立 | 40配置弹窗与工具行：account/manual/official/unknown；官方未登录/已登录及星芒Key状态 | 不以configured单值覆盖所有前置；官方身份不受星芒余额控制；unknown需说明影响后选择处理 | J02/T01/T04 |
| G04 Codex共享配置 | CLI与桌面端共用配置、来源档案切换和桌面重启 | 40的provider归一化、XM.setToolConfig、config页签、来源选择与保存步骤；两入口同步 | 统一配置对象/路径，官方模型在官方窗口选择；整份来源档案保存/恢复由适配器实现，配置成功与重启失败分开 | T01/T02/T03 |
| G05 官方额度 | 官方邮箱、套餐、续期、窗口、重置时间/次数 | 40官方卡片XM.officialMeter：signedIn/email/plan/renewal/resets/status/windows；loading/error/缺失与已登录分别展示 | 未知字段保持null并显示“尚未获取”；刷新失败不清已有身份、不拿星芒余额替代、不把未知变0 | T04/AC03 |
| G06 保存与启动方式 | 合并/重置、打开已有窗口/重启均已有 | 40配置→xmSaveMode→commitToolConfig；启动/重新打开。失败与多页签草稿保护 | 合并只改目标字段；重置说明备份和替换范围；保存当前工具不得丢另一页签草稿；恢复焦点/滚动 | T02/T03/UI-C05 |
| G07 Key完整管理 | 无限/自定义USD额度、具体到期；active/disabled/expired/exhausted；明文30秒隐藏 | 20密钥页与keyEditor，keySave/keyShow/keyRevoke；额度/日期校验、四状态、30秒隐藏 | Key状态按原因给动作；明文默认遮盖，显隐回调绑定对象；新建回填父配置，真实规则/权限由服务确认 | AC02/J05 |
| G08 看板与明细 | 独立用量看板/调用明细，范围和趋势/占比/排行/Token/RPM/TPM | 20的dashboard与usage独立页签；时间范围、图表文本、筛选/分页/详情、loading/empty/error | 保留指标与返回范围；本轮RPM/TPM为所选范围平均，不称峰值；缺失/截断信息由数据适配保留 | AC01/AC03/UI-C07 |
| G09 扩展归属与授权 | 技能/插件按Provider，capability约束；MCP OAuth/Bearer | 30的mcpHtml/skillsHtml/pluginsHtml；Provider/scope、HTTP/stdio/SSE、认证/启停/只读/更新/删除 | Provider和scope分开；能力未知需给明确状态，不能复制fixture缺字段默认放行；授权结果与草稿分别保存 | EX01/EX02/EX03 |
| G10 内置星芒AI技能 | 生成/编辑图片；安装/登录/来源联动，Codex官方时停用 | 30的system/builtin技能及builtinState派生待安装/待配置/就绪/因来源暂不可用；详情解释生成/编辑用途 | 内置项只读、随应用更新；真实可执行状态由工具来源适配，不把派生UI标签当后端启停完成 | EX02/EX04 |
| G11 记录/备份/回收 | 仅能力允许的Codex会话归档；四Provider文件白名单；仅Codex技能回收 | 30记录与Drawer、备份预览/恢复、Codex技能回收站；readonly/capability、校验/失败/取消/完成 | 白名单精确、预览脱敏；恢复前快照、写前校验、回读；仅适用对象有归档/恢复，确认后再次检查条件 | EX05/BK01/BK02 |
| G12 金额与统计 | quota/quotaPerUnit换算USD，小额费用需精度；不以累计值冒充本月 | 20账户、Key、调用及报价；6位内部示例计算、2/4/6位显示；40官方独立；85额度结果 | 真实换算用权威口径；未知保留—，不能沿用demo初始化??0；支付币种/到账USD/统计范围各自明确 | AC03/AC04/CH01 |
| G13 充值与订阅支付 | 渠道动态，可能URL或POST表单；等待10分钟；订单查询决定到账 | 20充值/订阅→quote→order；pending/querying/paid/failed/unknown/timeout；关闭/恢复查询/重复结果 | 报价同一快照含owner/币种/实付/折扣/有效期；返回保留，失效重取；回跳只查询，幂等结算与账号归属 | AC04/AC05/AC06 |
| G14 多订阅与偏好 | 多订阅、额度/到期/状态/购买次数；四种偏好 | 20 subscriptions与preference；subscription_first/balance_first/subscription_only/balance_only；余额/在线购买、次数占位 | 不用单一user.plan代替列表；待付款占位和已购次数分别处理；不跨“仅”偏好自动扣另一来源 | AC07 |
| G15 本机多账号 | 代码基线是单会话/单凭据文件；登录设备不是本机多账号 | **新增设计**：20账号列表/添加/切换/退出，40逐工具同步，85聊天归属；switching/expired/partial与迟到请求 | 使用稳定账号ID隔离数据与凭据；先验证目标再切；官方/manual/unknown不被强切；旧请求不污染新账号 | AC08/AC09/CH02 |
| G16 找回与认证政策 | 发送重置邮件、trim后提交token、新密码展示/复制/回登录已有；整链接提取未在基线实现 | 10认证；**新增交互**12-recovery三步，HTTP(S)唯一token解析、发送/过期/重置/复制失败与重试、返回唯一登录层 | 邮件中性反馈；UI解析不代替服务校验；60秒与固定结果是演示；请求绑定session/dialog/id，真实锁定/限流不由本地猜定 | J06/J05 |
| G17 平台与系统能力 | Windows托管运行时/桌面端；mac外部安装；内部文件协议不能证明外部深链；主窗口关闭关联子窗口 | 50十一版本/五Linux会话；10/40安装分流；80设置/通知；95深链入口；**新增设计**托盘/关闭/外部唤起 | 能力运行时检测；无托盘保留窗口，无通知走应用内；原生生命周期、单实例和付款/画布窗口归属按真实接入验证 | UI-P01/UI-P02/J03/MT03/IN01 |
| G18 即时设置 | 基线多数设置显式保存并保护草稿，主题例外 | **行为变更设计**80八组单面板、A.setting逐项saving/saved/failed、重试、并发最新值；外观即时预览 | 非即时项失败回退，文本留attempt；实际持久化/权限/需重启由适配结果说明；外观本地预览与写入错误分开 | UI-L04/MT02/MT06 |
| G19 品牌规范替代 | 基线design-system/ai/MASTER.md是灰绿风格，与Starlight Gold不同 | **本轮品牌/组件设计**tokens、00/50布局、主原型53个Lucide符号（组件页51个子集）、45组件检阅、欢迎/画布共享语义 | 真实旧变量逐项定位后映射；不只宣布旧规范作废；两主题、主窗口/画布/组件页共用14与36/32/28，密集例外见01 | UI-C01/UI-L01/UI-L06/CV01 |

## 2. UI字段与事件登记

| 域 | 字段/状态 | 原型事件与实现约束 |
|---|---|---|
| 准备 | route、step、status、run、工具安装/来源 | A.guideChoose、登录/注册、安装/配置动作；返回保留选路，不统一写所有工具 |
| 配置 | Provider归一化；configured/source/key/model/manual；工具页签草稿、保存方式 | XM.toolSource、XM.setToolConfig、A.configTab、A.commitToolConfig、A.launch；表单草稿与已确认配置分开 |
| 官方 | signedIn/email/plan/renewal/resets/windows/status；window含label/remaining/reset | A.checkOfficialLogin、A.refreshOfficialUsage、XM.officialMeter；未知/错误保留既有信息 |
| Key | id/name/group/quotaMode/quota/usedUSD/expiresAt/status/show | A.keySave/keyShow/keyRevoke；状态由限制原因决定，30秒回调不误显其他账号对象 |
| 账户 | user/keys/orders/usage/tasks/devices/chat/subscriptions/preference | XM.authComplete/accountStore/accountData；A.openAccount/switchAccount/logout；真正身份键用稳定ID |
| 报价订单 | owner、kind、amountUSD、currency、checkoutAmount、channel、expiresAt、quote、status、credited | A.pay/payClose/accountOrderQuery/subscribe；报价确认同源，credited演示幂等不能代替服务结算 |
| 扣费 | amountUSD/balanceUSD/subscriptionUSD/source；可用订阅与preference | XM.accountCanCharge预检、XM.accountCharge模拟分摊；真实请求以权威扣费结果为准 |
| MCP | mname/mtype/mtarget/mauth/bearerEnv/clientId/resource/envName/envValue | A.mcpNew/Edit/Add/Toggle/OAuthRun；stdio无网页认证，HTTP/SSE按服务方要求 |
| 技能插件 | provider/scope/source/builtin/enabled/capability；市场source/branch | skill/plugin启停/更新/移除及市场动作；系统项只读，市场移除后阻止依赖该来源的更新 |
| 记录备份 | tool/canArchive/archived、文件名白名单、verification、operation phase | A.sessionArchive/Unarchive、backupCreateRun/Preview/RestoreRun；确认后再核能力，失败保留快照 |
| 维护 | 设置save记录before/attempt/phase；migration快照/阶段；report；update.phase | A.setting/settingRetry/settingsMigrate/settingsRollback、healthRun、报告/更新动作；最新请求获胜 |
| 找回 | email/token与recovery.phase/sendState/resetState/copyState/parsedToken/requestId | A.sendReset/resetPw/recoveryParse/recoveryCopy/recoveryGoLogin；邮箱/流程变化使旧回调失效 |
| 聊天 | conversation/requestId/owner、draft、uiError、cancelled、模型与分组 | A.chatSend及重试/停止；错误保留用户消息，旧账号请求不进入当前会话 |
| 画布 | S.canvas45含view/projects/project/selected/zoom/dirty/save/run/modal/undo/link/source/target；节点text/model/image/result、边为ID对；save.phase=saved/dirty/saving/failed，run.phase=idle/invalid/running/stopped/failed/done；modal为new/unsaved/running/delete/import/image | A.openCanvas/closeCanvas/canvasNavigate/canvasHasPending/canvasCloseThen；canvasNew/Create/OpenProject；canvasAdd/Edit/Move/Drag/DeleteConfirm/Undo/Connect/RemoveEdge；canvasSave/Run/Stop；canvasImport/Export。字段与保护见04，验收CV01–CV05 |

字段命名是当前原型定位线索，真实工程可使用现有类型名与适配器；不可把demo账号显示名、固定路径、定时成功、模型列表或报价渠道写成服务端事实。

画布场景A.canvasScenario支持demo/empty/missingInput/unconnected/saveFailure/runFailure；canvasScenario('save'或'run','failure')注入下一次失败。图保存在本次S，导入导出为xingmang-canvas-demo v1；参数和本地构图不代表真实AI产物。保存/运行锁相关编辑，异步按S、canvas45、canvasOpen和操作ID校验；canvasHasPending供主窗口判断，canvasCloseThen在保护完成后继续关闭，取消清回调且旧S不回调。

## 3. 共享约束与继承关系

表单状态按流程实例保存来源、对象、页签、字段、dirty、错误、返回焦点与滚动。子Dialog成功只更新父字段；失败与取消保留父草稿。列表页筛选/分页/详情返回不丢上下文。能力按对象/Provider/平台共同判断，确认后仍需复核；只读和未知能力不是网络失败。

固定备份白名单：Claude settings.json；Codex config.toml/auth.json；Gemini settings.json/.env；Grok config.toml。当前原型路径为平台样例，真实读取与恢复白名单由适配器定位；不扩大为整个用户目录。回滚保留迁移前与新版时点快照，见11。

品牌替代按语义角色映射：旧窗口/导航/内容底色→--win/--rail/--bg；旧卡片/浮层/控件→--panel/--panel-solid/--panel-2；旧文本层级→--text/--text-2/--text-3；旧主动作→--accent/--accent-fg/--accent-soft；旧信息/成功/警告/错误→--info/--ok/--warn/--bad。12没有提供旧变量名，因此本表不虚构精确旧Token；接入时补实际符号、引用页面与截图。共享组件变体与45→旧21映射见02，画布与主窗口共用品牌语义。

## 4. 如何记录对齐完成

每个G行附实际UI用例、模块/HTML版本与截图；真实集成另附接口/IPC结果、文件校验或平台证据。本文没有执行浏览器、付款、安装或系统调用；静态核对结果不能被转写为这些操作通过。

[10验收清单](10-acceptance-checklist.md)中的J/T/AC/CH/EX/BK/MT/CV/IN/UI条目可以直接执行；[16](16-final-validation.md)登记本轮结果。12和13保留历史不重写，本表承接其结论与本轮设计。
