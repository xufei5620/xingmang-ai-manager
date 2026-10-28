# 历史编号与当前复核对照索引

本页逐项覆盖历次审查的 **78 个编号＋39 条补充结论**。当前复核基线是 `c21be2741af6674b2f422d9891b57fc3d2ba5b7b`，后续 `444ecc18` 差异另页记录，不倒改本基线结论。具体源码、修复方案与验收以负责域报告为准。

“本轮复现”与“当前代码核对后复用旧证据”分别标明；尚无当前报告的编号明确保留待复核。优先级表示修复排期，已修项表示保留回归的等级，不计入待修数量。安全条目按仓库公开策略仅保留抽象影响与状态，详情留在受控本地材料。

已阅读当前域报告：install_clients、platform_network、accounts_routes、core、legacy、canvas_ai、release、renderer。

## 78 项编号问题

| 原ID / 台账ID | 问题 | 主owner（协作） | 当前状态 | 优先级 | 当前依据 | 修复方案与验收 |
|---|---|---|---|---|---|---|
| #1 / O01 | MCP 参数里的密钥进入日志和反馈 | core（install_clients） | 已修复（当前维持） | P2，保留回归 | 当前敏感参数收集/脱敏静态复核＋哈希/原反例复用；command-runner:936与redaction-patterns:154保护仍在；不是只引用历史已修标签。 [证据说明](domains/core.md) | [core](domains/core.md) |
| #2 / O02 | 普通星芒账号误用同组其他不限额 Key | accounts_routes | 已修复（当前维持） | P2，保留回归 | 当前Key用途过滤/限额保护及测试断言复读＋旧动态证据复用；new-api-client:2639/4085-4108仍按托管名称用途过滤，不误用同组无关不限额Key。 [证据说明](domains/accounts_routes.md) | [accounts_routes](domains/accounts_routes.md) |
| #3 / O03 | 历史账号换订阅分组丢失限额和到期日 | accounts_routes | 仍存在 | P2，金额相关优先 | 当前根因/调用边界复读＋哈希一致的旧离线证据复用；当前账号专项逐项列代码、复用反例和修复/验收；本轮未重复运行这些旧夹具。 [证据说明](domains/accounts_routes.md) | [accounts_routes](domains/accounts_routes.md) |
| #4 / O04 | 复制画布后提示复用缓存却重新生成 | canvas_ai | 仍存在 | P1 | 当前根因复读＋全清单同哈希旧隔离证据复用；复制副本预检0付费/1缓存，真实引擎仍生成1次；当前根因代码同哈希，未推算金额。 [证据说明](domains/canvas_ai.md) | [canvas_ai](domains/canvas_ai.md) |
| #5 / O05 | 剧本解析漏算付费调用 | canvas_ai | 仍存在 | P2 | 当前根因复读＋全清单同哈希旧隔离证据复用；当前剧本执行含1至2次文字请求而预检记0；旧真实执行结果复用。 [证据说明](domains/canvas_ai.md) | [canvas_ai](domains/canvas_ai.md) |
| #6 / O06 | 选了历史图片 A，下游仍使用图片 B | canvas_ai | 仍存在 | P1 | 当前根因复读＋全清单同哈希旧隔离证据复用；候选选择A与IPC均为A，旧真实引擎下游却用缓存B；当前根因同哈希。 [证据说明](domains/canvas_ai.md) | [canvas_ai](domains/canvas_ai.md) |
| #7 / O07 | 启动自动更新打断聊天或画布 | core（release） | 仍存在（部分路径已有保护） | P2 | 当前main启动更新接线复核＋旧动态证据复用；启动自动安装两次busy只看安装队列；另一prompter的工作保护不覆盖它。 [证据说明](domains/core.md) | [core](domains/core.md) |
| #8 / O08 | 旧登录恢复覆盖新登录凭据 | accounts_routes（core） | 仍存在 | P2 | 当前根因/调用边界复读＋哈希一致的旧离线证据复用；当前账号专项逐项列代码、复用反例和修复/验收；本轮未重复运行这些旧夹具。 [证据说明](domains/accounts_routes.md) | [accounts_routes](domains/accounts_routes.md) |
| #9 / O09 | 扩展操作慢返回后串到另一工具列表 | renderer | 已修复（当前维持） | P2，保留回归 | 当前1762行全文与所有操作回调保护复核＋旧动态修复证据复用；ExtensionsPage:301-304统一reloadList检查当前provider，添加/删除/认证/安装及提示、健康检查均复核；不是只引用旧修复标签。 [证据说明](domains/renderer.md) | [renderer](domains/renderer.md) |
| #10 / O10 | MCP 换密钥失败却提示成功 | install_clients | 仍存在 | P2 | 当前根因/哈希核对＋旧隔离证据复用；报告逐项给出当前行号、相关源码哈希与原正反例；未重新运行全部安装/扩展夹具。 [证据说明](domains/install_clients.md) | [install_clients](domains/install_clients.md) |
| #11 / O11 | 保存或回滚配置覆盖其他程序刚做的修改 | core（install_clients） | 仍存在 | P2 | 本轮原模块离线反例及正常对照；本轮真实文件计划：保存覆盖外部改写、既有文件回滚覆盖外部改写、新文件回滚删除外部改写；正常提交对照通过。 [证据说明](domains/core.md) | [core](domains/core.md) |
| #12 / O12 | 管理员模式卸载丢失实际安装目录 | install_clients | 仍存在 | P2 | 当前根因/哈希核对＋旧隔离证据复用；报告逐项给出当前行号、相关源码哈希与原正反例；未重新运行全部安装/扩展夹具。 [证据说明](domains/install_clients.md) | [install_clients](domains/install_clients.md) |
| #13 / O13 | 生成中改提示词，旧结果清掉待更新标记 | canvas_ai | 仍存在 | P2 | 当前根因复读＋全清单同哈希旧隔离证据复用；输入编辑后旧run完成仍清dirty；当前投影根因未变。 [证据说明](domains/canvas_ai.md) | [canvas_ai](domains/canvas_ai.md) |
| #14 / O14 | 复制项目的素材仍被旧路径缓存牵连 | canvas_ai | 仍存在 | P2 | 当前根因复读＋全清单同哈希旧隔离证据复用；副本合法素材存在，但旧位置缓存读失败不再查副本；当前根因未变。 [证据说明](domains/canvas_ai.md) | [canvas_ai](domains/canvas_ai.md) |
| #15 / O15 | 画布小地图、专注模式和面板偏好不保存 | canvas_ai | 仍存在 | P3 | 当前根因复读＋全清单同哈希旧隔离证据复用；初始化完成后用户偏好更改不触发保存；真实effect旧结果复用。 [证据说明](domains/canvas_ai.md) | [canvas_ai](domains/canvas_ai.md) |
| #16 / O16 | 按 / 搜索落到隐藏页面 | renderer | 仍存在 | P2 | 当前完整调用链/哈希复核＋旧原组件或真实模块证据复用；当前v2全viewport搜索首个框＋App缓存hidden/inert页面仍在；不是legacy，旧真实组件证据复用。 [证据说明](domains/renderer.md) | [renderer](domains/renderer.md) |
| #17 / O17 | 本地导入范围的完整性保障不足 | install_clients | 条件性风险仍适用 | P2，安全边界优先 | 当前静态核对＋相同哈希旧证据复用；当前源码复核与相同哈希的旧证据一致；本轮未重新动态验证。 [证据说明](security-status.md) | [安全摘要](security-status.md) |
| N1 / N1 | 手机遥控显示已关闭，迟到的任务仍会启动 | install_clients | **已修复（#1495，云端核实）** | 保留回归 | 原复现基于 c21be274；#1495（029a020）在启动、初始化、开线程三个等待点都回头核对这一轮是否仍有效，迟到起好的 Codex 当场收掉。剩一个窄口子见 [核实结果](verification.md)。 | [install_clients](domains/install_clients.md) |
| N2 / N2 | 视频提交结果不明确，重开后却显示“还没生成” | renderer（canvas_ai） | 仍存在 | P1，优先 | 当前完整调用链/哈希复核＋旧原组件或真实模块证据复用；c21保存/恢复仍清未知状态，主进程任务号未回时无可恢复记录；旧浏览器与服务mock复用，444ecc18另页。 [证据说明](domains/renderer.md) | [renderer](domains/renderer.md) |
| N3 / N3 | 订阅确认框停留在旧价格，提交时没有核对价格 | renderer | 仍存在 | P2，金额相关，建议优先 | 当前完整调用链/哈希复核＋旧原组件或真实模块证据复用；旧确认对象与只带plan_id的提交仍存在；旧组件按新价扣费为mock，不是生产扣款。 [证据说明](domains/renderer.md) | [renderer](domains/renderer.md) |
| N4 / N4 | “另存图片”失败，原有文件可能已经被写坏 | canvas_ai（renderer） | 仍存在 | P2，文件损坏风险，建议优先 | 当前根因复读＋全清单同哈希旧隔离证据复用；图片/视频直接覆盖目标仍在；视频部分写入失败损坏目标，库内原片未损坏；音频为静态同根因。 [证据说明](domains/canvas_ai.md) | [canvas_ai](domains/canvas_ai.md) |
| N5 / N5 | 切换账号后，先前点击的“打开”可能用新账号启动 | core（renderer） | 仍存在 | P2 | 本轮IPC全程接线复核＋旧动态/真实界面证据复用；目录await之后才capture accountWork.queue，队列内保护不覆盖此前换号窗口。 [证据说明](domains/core.md) | [core](domains/core.md) |
| N6 / N6 | 密码实际改好了，软件却仍自动填旧密码 | accounts_routes（renderer） | 仍存在 | P2 | 当前根因/调用边界复读＋哈希一致的旧离线证据复用；当前账号专项逐项列代码、复用反例和修复/验收；本轮未重复运行这些旧夹具。 [证据说明](domains/accounts_routes.md) | [accounts_routes](domains/accounts_routes.md) |
| N7 / N7 | 长聊天切到生图，短描述也被错误拦住 | renderer | 仍存在 | P2 | 当前完整调用链/哈希复核＋旧原组件或真实模块证据复用；长历史限制仍用于仅发送当前prompt的生图；旧100条历史拒绝/新会话成功对照复用。 [证据说明](domains/renderer.md) | [renderer](domains/renderer.md) |
| N8 / N8 | 手机遥控的中文回复或审批内容可能变成乱码 | install_clients | 仍存在 | P2 | 本轮真实模块离线复现；多字节Buffer分块后产生替代字符，JSON仍分发；当前remote-result。 [证据说明](domains/install_clients.md) | [install_clients](domains/install_clients.md) |
| N9 / N9 | 检测中途打开客户端，关闭后不会自动补切线路 | install_clients | 仍存在 | P2 | 当前根因/哈希核对＋旧隔离证据复用；报告逐项给出当前行号、相关源码哈希与原正反例；未重新运行全部安装/扩展夹具。 [证据说明](domains/install_clients.md) | [install_clients](domains/install_clients.md) |
| N10 / N10 | 同一客户端装了两份，会漏看第二份正在运行 | install_clients | 仍存在 | P2，限定双安装场景 | 当前根因/哈希核对＋旧隔离证据复用；报告逐项给出当前行号、相关源码哈希与原正反例；未重新运行全部安装/扩展夹具。 [证据说明](domains/install_clients.md) | [install_clients](domains/install_clients.md) |
| N11 / N11 | 新手引导把“先不打开”误当成完成 | renderer | 仍存在 | P3，体验问题 | 当前完整调用链/哈希复核＋旧原组件或真实模块证据复用；原生declined仍返回成功导致完成引导；文件夹取消对照正常。 [证据说明](domains/renderer.md) | [renderer](domains/renderer.md) |
| D01 / D01 | 切换画布项目后，“撤销”会覆盖另一个项目 | canvas_ai | 仍存在 | P1 | 当前根因复读＋全清单同哈希旧隔离证据复用；当前打开项目仍入同一撤销栈；旧真实浏览器与存储确认A图可写入B。 [证据说明](domains/canvas_ai.md) | [canvas_ai](domains/canvas_ai.md) |
| D02 / D02 | 导入聊天记录，会悄悄删除原有对话 | renderer | 仍存在 | P2 | 当前完整调用链/哈希复核＋旧原组件或真实模块证据复用；当前导入合并截断50条与真实store删除链复核；旧50+1实际临时文件删除证据复用。 [证据说明](domains/renderer.md) | [renderer](domains/renderer.md) |
| D03 / D03 | 便签里的网址、路径或 TODO 可能保存后消失 | canvas_ai | 仍存在 | P2 | 当前根因复读＋全清单同哈希旧隔离证据复用；普通便签文字受设置清洗，链接/路径等保存后丢失；当前根因未变。 [证据说明](domains/canvas_ai.md) | [canvas_ai](domains/canvas_ai.md) |
| D04 / D04 | Codex 显示配置成功，启动却删掉刚保存的凭据 | core（install_clients） | 仍存在（运行版本限制保留） | P2 | 本轮真实配置保存/检查对照；CLI运行表现复用旧版本；merge保留forced_login_method=chatgpt同时API Key检查可用；auth删除仅旧Codex0.157.1实测，不泛化当前推荐版本。 [证据说明](domains/core.md) | [core](domains/core.md) |
| D05 / D05 | 升级会把用户额外文件误认成软件文件，之后删掉 | release | 仍存在 | P2 | 当前根因及差异复核＋旧隔离证据复用；当前NSIS记录/清理根因同哈希；旧内存解释验证首次保留外来文件会进入下一次清理名单，没有真实卸载。 [证据说明](domains/release.md) | [release](domains/release.md) |
| D06 / D06 | 选择“保留全部输入”，生成仍只用第一张参考图 | canvas_ai | 仍存在 | P2 | 当前根因复读＋全清单同哈希旧隔离证据复用；all选项未传策略且引擎仅取首个输出；旧实际mock只收到A。 [证据说明](domains/canvas_ai.md) | [canvas_ai](domains/canvas_ai.md) |
| D07 / D07 | 短剧里的角色、场景可能错误连成同一道具 | canvas_ai | 仍存在 | P2 | 当前根因复读＋全清单同哈希旧隔离证据复用；类别内唯一编号在铺图共用Map碰撞；当前根因与旧解析/编译对照一致。 [证据说明](domains/canvas_ai.md) | [canvas_ai](domains/canvas_ai.md) |
| D08 / D08 | 选中的素材与详情操作对象对不上 | canvas_ai | 仍存在 | P2 | 当前根因复读＋全清单同哈希旧隔离证据复用；取消B选择后详情锚点仍B；旧真实组件证明选中集合与操作对象不同。 [证据说明](domains/canvas_ai.md) | [canvas_ai](domains/canvas_ai.md) |
| D09 / D09 | 图片文件丢失时，会在两个失败地址间反复重试 | canvas_ai | 仍存在 | P2 | 当前根因复读＋全清单同哈希旧隔离证据复用；主图和备用都失败时反复切换；当前状态机与旧浏览器8次有界观察一致。 [证据说明](domains/canvas_ai.md) | [canvas_ai](domains/canvas_ai.md) |
| D10 / D10 | AI 回答被截断，也会显示成正常完成 | canvas_ai | 仍存在 | P2 | 当前根因复读＋全清单同哈希旧隔离证据复用；截断/过滤均压成complete；旧SSE长度/过滤/正常stop对照复用。 [证据说明](domains/canvas_ai.md) | [canvas_ai](domains/canvas_ai.md) |
| D11 / D11 | 切账号时，七日用量可能长期串到另一个账号 | renderer | 仍存在 | P2 | 当前完整调用链/哈希复核＋旧原组件或真实模块证据复用；当前请求到持久缓存未绑定完整scope；旧handler/gate交错证明B用量留存到A，仅显示影响。 [证据说明](domains/renderer.md) | [renderer](domains/renderer.md) |
| D12 / D12 | 配置出问题时，诊断报告反而导不出来 | core | 仍存在 | P2 | 当前诊断/导出接线复核＋相同哈希旧实文件反例复用；不可读配置可令已完成诊断导出失败；安全拒绝本身正确，不放宽路径规则。 [证据说明](domains/core.md) | [core](domains/core.md) |
| D13 / D13 | 会话归档后可能再也无法从界面恢复 | install_clients | 仍存在 | P2 | 当前根因/哈希核对＋旧隔离证据复用；报告逐项给出当前行号、相关源码哈希与原正反例；未重新运行全部安装/扩展夹具。 [证据说明](domains/install_clients.md) | [install_clients](domains/install_clients.md) |
| D14 / D14 | 导出会话时磁盘写入失败，会使整个应用退出 | core | 仍存在 | P2 | 本轮原模块离线反例及正常对照；本轮真实会话导出注入写入失败：Promise拒绝之外出现一次uncaughtException；正常文件对照通过。 [证据说明](domains/core.md) | [core](domains/core.md) |
| D15 / D15 | 取消 Windows 关机后，软件会一直以为正在关机 | core | 仍存在 | P2 | 本轮原模块离线反例及正常对照；本轮真实生命周期事件：取消关机后普通退出跳过确认；普通退出/已确认关机作为对照。 [证据说明](domains/core.md) | [core](domains/core.md) |
| D16 / D16 | 正式版残留入口会挡住已安装的 Codex Beta | install_clients | 仍存在 | P2 | 当前根因/哈希核对＋旧隔离证据复用；报告逐项给出当前行号、相关源码哈希与原正反例；未重新运行全部安装/扩展夹具。 [证据说明](domains/install_clients.md) | [install_clients](domains/install_clients.md) |
| D17 / D17 | 自定义 HOME 后，刚装好的 Grok 被判为不能卸载 | install_clients（core） | 仍存在 | P2 | 当前根因/哈希核对＋旧隔离证据复用；报告逐项给出当前行号、相关源码哈希与原正反例；未重新运行全部安装/扩展夹具。 [证据说明](domains/install_clients.md) | [install_clients](domains/install_clients.md) |
| D18 / D18 | Windows 首装 Grok 后，自己开的终端找不到命令 | install_clients | 仍存在 | P3 | 当前根因/哈希核对＋旧隔离证据复用；报告逐项给出当前行号、相关源码哈希与原正反例；未重新运行全部安装/扩展夹具。 [证据说明](domains/install_clients.md) | [install_clients](domains/install_clients.md) |
| D19 / D19 | Mac/Linux 更新 Grok，agent 命令仍用旧版 | platform_network | 仍存在 | P2 | 当前根因/依赖哈希核对＋旧隔离证据复用；当前报告保留精确平台条件、负对照与测试缺口；本轮未执行原生平台测试。 [证据说明](domains/platform_network.md) | [platform_network](domains/platform_network.md) |
| D20 / D20 | Mac 从某些 Bash 环境启动后，打开工具会失败 | platform_network | 仍存在 | P2 | 当前根因/依赖哈希核对＋旧隔离证据复用；当前报告保留精确平台条件、负对照与测试缺口；本轮未执行原生平台测试。 [证据说明](domains/platform_network.md) | [platform_network](domains/platform_network.md) |
| D21 / D21 | 自动切线重试成功后，漏掉需要重开工具的提醒 | accounts_routes（platform_network） | 仍存在 | P2 | 当前根因/调用边界复读＋哈希一致的旧离线证据复用；当前账号专项逐项列代码、复用反例和修复/验收；本轮未重复运行这些旧夹具。 [证据说明](domains/accounts_routes.md) | [accounts_routes](domains/accounts_routes.md) |
| D22 / D22 | Mac 加速崩溃后，网络未恢复却没有主动提醒 | platform_network | 仍存在 | P2 | 当前根因/依赖哈希核对＋旧隔离证据复用；当前报告保留精确平台条件、负对照与测试缺口；本轮未执行原生平台测试。 [证据说明](domains/platform_network.md) | [platform_network](domains/platform_network.md) |
| D23 / D23 | 关掉自动更新，迟到的检查仍会自动下载 | release | 仍存在 | P2 | 当前根因及差异复核＋旧隔离证据复用；本轮重读迟到回调及测试，当前仍无ON转OFF守卫；旧service模拟关闭后下载次数1复用。 [证据说明](domains/release.md) | [release](domains/release.md) |
| D24 / D24 | 导入主题显示成功，重开却变回旧主题 | renderer | 仍存在 | P3 | 当前完整调用链/哈希复核＋旧原组件或真实模块证据复用；导入只写AppSettings，平台主题未写；旧DOM/选项/重绑对照复用。 [证据说明](domains/renderer.md) | [renderer](domains/renderer.md) |
| D25 / D25 | 界面报登录超时，后台却留下未回收会话 | accounts_routes | 仍存在 | P2 | 当前根因/调用边界复读＋哈希一致的旧离线证据复用；当前账号专项逐项列代码、复用反例和修复/验收；本轮未重复运行这些旧夹具。 [证据说明](domains/accounts_routes.md) | [accounts_routes](domains/accounts_routes.md) |
| D26 / D26 | 两个站点编号相同，异常花费提醒会互相压住 | accounts_routes | 仍存在 | P3 | 当前根因/调用边界复读＋哈希一致的旧离线证据复用；当前账号专项逐项列代码、复用反例和修复/验收；本轮未重复运行这些旧夹具。 [证据说明](domains/accounts_routes.md) | [accounts_routes](domains/accounts_routes.md) |
| D27 / D27 | 大小写不同的两个项目，会少一个续聊入口 | renderer | 仍存在 | P3 | 当前完整调用链/哈希复核＋旧原组件或真实模块证据复用；当前路径小写化合并仍在；限定区分大小写文件系统，未删除聊天文件。 [证据说明](domains/renderer.md) | [renderer](domains/renderer.md) |
| S01 / S01 | 更新安装内容与验证结果的持续绑定不足 | release | 条件性安全风险仍存在 | P2，更新边界优先 | 当前根因及差异复核＋旧隔离证据复用；状态和受控证据等级见安全摘要；没有实际利用的证据。 [证据说明](security-status.md) | [安全摘要](security-status.md) |
| S02 / S02 | 运行环境分发内容的整体完整性核验不足 | platform_network | 条件性风险仍存在 | P2，供应链优先 | 当前静态/哈希核对＋旧隔离证据复用；当前源码复核、旧隔离证据复用；必要外部条件未在生产证实。 [证据说明](security-status.md) | [安全摘要](security-status.md) |
| S03 / S03 | 旧回滚界面的账号上下文隔离不足 | legacy | 仍存在 | P2，账号隔离优先 | 本轮真实React18组件复现＋不同用户负对照；本轮隔离组件正反对照确认；仅legacy，按冻结规则实施安全修复。 [证据说明](security-status.md) | [安全摘要](security-status.md) |
| S04 / S04 | 外部输入处理的共享状态隔离不足 | accounts_routes | 条件性风险仍存在 | P2，输入隔离优先 | 当前统计聚合根因复读＋旧原模块响应模拟复用；当前源码与旧隔离证据一致；不等同生产可控性或真实利用证明。 [证据说明](security-status.md) | [安全摘要](security-status.md) |
| T01 / T01 | 开发用影子目录不一定隔离日常 Codex 配置 | release | 仍存在 | P2 | 当前根因及差异复核＋旧隔离证据复用；本轮全文重读影子脚本，专用目录变量仍继承；旧真实路径解析的两种变量对照复用。 [证据说明](domains/release.md) | [release](domains/release.md) |
| T02 / T02 | 发布校验器的请求前目标约束不足 | release | 仍存在 | P2 | 当前根因及差异复核＋旧隔离证据复用；具体状态及修复验收见安全摘要；公开版本不披露触发方式和精确入口。 [证据说明](security-status.md) | [安全摘要](security-status.md) |
| T03 / T03 | 发布下载页中途断线，可能把下载按钮全部弄没 | release | 仍存在（静态故障路径） | P2（静态） | 当前根因及差异复核＋旧隔离证据复用；下载页清单原地覆盖的静态故障路径同哈希；本轮未模拟真实上传中断。 [证据说明](domains/release.md) | [release](domains/release.md) |
| T04 / T04 | 隐私政策弹窗可能显示用户协议正文 | release | 仍存在 | P3 | 当前根因及差异复核＋旧隔离证据复用；法律弹窗请求没有代次守卫；当前源码同哈希，未作线上展示验证。 [证据说明](domains/release.md) | [release](domains/release.md) |
| T05 / T05 | 后台关闭邮箱验证，下载页仍显示验证码栏 | release | 仍存在 | P3 | 当前根因及差异复核＋旧隔离证据复用；验证码区域隐藏规则仍冲突；当前源码同哈希，未作线上展示验证。 [证据说明](domains/release.md) | [release](domains/release.md) |
| F01 / F01 | 刚设好的工具额度上限，会被一次改名取消 | accounts_routes（renderer） | 仍存在 | P2 | 当前根因/调用边界复读＋哈希一致的旧离线证据复用；当前账号专项逐项列代码、复用反例和修复/验收；本轮未重复运行这些旧夹具。 [证据说明](domains/accounts_routes.md) | [accounts_routes](domains/accounts_routes.md) |
| F02 / F02 | 切到画布副本，会继承另一个项目的生成状态和候选图 | canvas_ai（renderer） | 仍存在 | P2 | 当前根因复读＋全清单同哈希旧隔离证据复用；切同节点ID副本未清运行态，候选可随B保存；B提示词/结果未被覆盖，重开恢复idle。 [证据说明](domains/canvas_ai.md) | [canvas_ai](domains/canvas_ai.md) |
| F03 / F03 | Mac 更新已接受取消，却仍继续换成新版 | platform_network（install_clients、renderer） | 仍存在 | P2 | 当前根因/依赖哈希核对＋旧隔离证据复用；当前报告保留精确平台条件、负对照与测试缺口；本轮未执行原生平台测试。 [证据说明](domains/platform_network.md) | [platform_network](domains/platform_network.md) |
| F04 / F04 | Mac 更新可能把客户端从更高版本降回较低版本 | platform_network（install_clients） | 仍存在 | P2 | 当前根因/依赖哈希核对＋旧隔离证据复用；当前报告保留精确平台条件、负对照与测试缺口；本轮未执行原生平台测试。 [证据说明](domains/platform_network.md) | [platform_network](domains/platform_network.md) |
| F05 / F05 | 更新期间打开其他工具，Codex 更新后可能不自动重开 | renderer（install_clients） | 仍存在 | P2 | 当前完整调用链/哈希复核＋旧原组件或真实模块证据复用；自动重开在另一启动pending时直接丢弃；旧交错与独立更新对照复用。 [证据说明](domains/renderer.md) | [renderer](domains/renderer.md) |
| 新问题 1 / R28-1 / R28-1 | 自家已经有新版，Windows 界面仍可能不给更新入口 | install_clients（renderer） | 仍存在 | P2 | 当前根因/哈希核对＋旧隔离证据复用；报告逐项给出当前行号、相关源码哈希与原正反例；未重新运行全部安装/扩展夹具。 [证据说明](domains/install_clients.md) | [install_clients](domains/install_clients.md) |
| 问题 2 / R28-2 / R28-2 | 聊天记录刚导入成功，又被自动保存删掉。 | renderer | 仍存在 | P2 | 当前完整调用链/哈希复核＋旧原组件或真实模块证据复用；导入期间可重进聊天，旧controller随后保存旧列表；旧真实App/store 1+1变回1证据复用。 [证据说明](domains/renderer.md) | [renderer](domains/renderer.md) |
| 问题 3 / R28-3 / R28-3 | 界面切到账号 B，工具仍使用账号 A 的配置。 | renderer（accounts_routes） | 仍存在 | P2 | 当前完整调用链/哈希复核＋旧原组件或真实模块证据复用；检测未完成候选为空但切换可点，后端空选择按仅切账号完成；旧延迟写0/正常写3对照复用。 [证据说明](domains/renderer.md) | [renderer](domains/renderer.md) |
| 问题 4 / R28-4 / R28-4 | 视频确认用一种模型，后面的镜头却自动换了模型和时长。 | renderer（canvas_ai） | 仍存在 | P2 | 当前完整调用链/哈希复核＋旧原组件或真实模块证据复用；c21队列仅保存镜头ID，出队读迟到更新的当前参数；旧第四段实际mock POST换模型/时长，444ecc18另页。 [证据说明](domains/renderer.md) | [renderer](domains/renderer.md) |
| 问题 5 / R28-5 / R28-5 | 一次临时读盘失败，会清空作品整理信息。 | canvas_ai | 仍存在 | P2 | 当前根因复读＋全清单同哈希旧隔离证据复用；一次EIO被当坏表并返回空元数据，后续写清旧记录；仍有备份，不声称素材文件不可恢复。 [证据说明](domains/canvas_ai.md) | [canvas_ai](domains/canvas_ai.md) |
| 问题 6 / R28-6 / R28-6 | 同时添加同一图片的两个副本，会一直发送失败。 | canvas_ai（renderer） | 仍存在 | P2 | 当前跨层根因复读＋7文件同哈希旧离线夹具复用；同批两个同内容附件生成相同ID，草稿合并漏去重后发送校验拒绝；分批对照正常，零AI调用/扣费，不是caption数量问题。 [证据说明](domains/canvas_ai.md) | [canvas_ai](domains/canvas_ai.md) |
| 问题 7 / R28-7 / R28-7 | 重新导入回收站图片，提示成功，但作品库里仍找不到。 | canvas_ai | 仍存在 | P3 | 当前根因复读＋全清单同哈希旧隔离证据复用；重导回收站同内容复用ID却保留deleted状态；旧真实handler/store与显式恢复对照复用。 [证据说明](domains/canvas_ai.md) | [canvas_ai](domains/canvas_ai.md) |
| 第二轮问题 1 / R2-1 | 特定视频拼接后，重新出现原片播放时隐藏的开头画面 | renderer | 仍存在 | P2（条件性素材） | 当前完整调用链/哈希复核＋旧原组件或真实模块证据复用；当前拼接原点仍含负PTS；旧原组件AVC/AAC导出重现隐藏前导帧与声音延迟，仅条件性素材。 [证据说明](domains/renderer.md) | [renderer](domains/renderer.md) |
| 第二轮问题 2 / R2-2 | 损坏的备份被当作不存在，错误原因和删除入口一起消失 | renderer（core） | 仍存在 | P3 | 当前完整调用链/哈希复核＋旧原组件或真实模块证据复用；坏清单provider=null仍被过滤；旧App/真实store有目录却UI无行，core本轮后端保留错误记录佐证。 [证据说明](domains/renderer.md) | [renderer](domains/renderer.md) |

## 39 条补充结论

“历史保留”不是声称当前仍未修；“外部未核实”不得写成线上事故。验证次数属于原报告，哈希复用不改称本轮重新执行。413 与 WebSocket 的现场结论以主审[专项报告](codex-413-incident.md)为准；其中仍未知的客户侧信息继续保留。

| ID | 补充主题 | 当前处置 | 依据或缺口 | 负责报告 |
|---|---|---|---|---|
| H-VERSION-01 | 最初审计的本地与远端差异及排除的已修问题 | 历史保留 | 原报告结果及限定基线保留；本轮没有同数场景重新执行的声明。 | [历史来源](history-coverage.md) |
| H-VERSION-02 | “别的版本”请求在同轮被转为查17项之外新问题 | 历史保留 | 原报告结果及限定基线保留；本轮没有同数场景重新执行的声明。 | [历史来源](history-coverage.md) |
| H-VERSION-03 | 全量深审基线与随后增量 | 历史保留 | 原报告结果及限定基线保留；本轮没有同数场景重新执行的声明。 | [历史来源](history-coverage.md) |
| H-VERSION-04 | Mac更新新增后的1b0039c8快照 | 历史保留 | 原报告结果及限定基线保留；本轮没有同数场景重新执行的声明。 | [历史来源](history-coverage.md) |
| H-VERSION-05 | 413核查已到c21be274但相关配置链未变 | 历史保留 | 原报告结果及限定基线保留；本轮没有同数场景重新执行的声明。 | [历史来源](history-coverage.md) |
| H-VALIDATION-01 | 初次全量未通过及平台限制 | 历史保留 | 原报告结果及限定基线保留；本轮没有同数场景重新执行的声明。 | [历史来源](history-coverage.md) |
| H-VALIDATION-02 | 原17项定向复核结果 | 历史保留 | 原报告结果及限定基线保留；本轮没有同数场景重新执行的声明。 | [历史来源](history-coverage.md) |
| H-VALIDATION-03 | 新增11项的现有检查与未执行筛选 | 历史保留 | 原报告结果及限定基线保留；本轮没有同数场景重新执行的声明。 | [历史来源](history-coverage.md) |
| H-ENV-01 | 审计夹具曾触发Electron开发依赖下载 | 历史保留 | 原报告结果及限定基线保留；本轮没有同数场景重新执行的声明。 | [历史来源](history-coverage.md) |
| H-COVERAGE-01 | 逐行审查并未覆盖全仓每一行 | 历史保留 | 原报告结果及限定基线保留；本轮没有同数场景重新执行的声明。 | [历史来源](history-coverage.md) |
| H-VALIDATION-04 | 深审全量测试worker异常仍未解决 | 历史保留 | 原报告结果及限定基线保留；本轮没有同数场景重新执行的声明。 | [历史来源](history-coverage.md) |
| H-VALIDATION-05 | 追加五项定向验证及平台边界 | 历史保留 | 原报告结果及限定基线保留；本轮没有同数场景重新执行的声明。 | [历史来源](history-coverage.md) |
| H-CHATGPT-IDENTITY | 此项目ChatGPT桌面安装模块的产品对应关系 | 当前可确认（项目命名边界） | 当前安装/平台报告继续按Windows Codex包与Mac ChatGPT应用分支讨论，未混用不相干安装机制。 | [install_clients](domains/install_clients.md) |
| H-CHATGPT-PASS-01 | ChatGPT安装31场景与3个界面对照 | 历史保留 | 原报告结果及限定基线保留；本轮没有同数场景重新执行的声明。 | [install_clients](domains/install_clients.md) |
| H-CHATGPT-OBS-01 | Windows可能先装星芒桶中间版本 | 当前可确认（仍只列观察） | 当前install_clients/platform_network报告仍保留观察，未提升为安装失败或状态损坏。 | [install_clients](domains/install_clients.md) |
| H-CHATGPT-OBS-02 | Mac首次芯片探测失败缓存为Intel | 当前可确认（仍只列观察） | 当前install_clients/platform_network报告仍保留观察，未提升为安装失败或状态损坏。 | [platform_network](domains/platform_network.md) |
| H-F03-SUPPLEMENT | ChatGPT取消边界修正 | 当前可确认 | platform_network当前复核确认同根因，保留ChatGPT等待关闭/最终提交的区分及降级对照。 | [platform_network](domains/platform_network.md) |
| H-F04-SUPPLEMENT | ChatGPT临时文件链再次确认旧降级场景 | 当前可确认 | platform_network当前复核确认同根因，保留ChatGPT等待关闭/最终提交的区分及降级对照。 | [platform_network](domains/platform_network.md) |
| H-VALIDATION-06 | 上一轮账号删除退出保护通过 | 历史保留 | 原报告结果及限定基线保留；本轮没有同数场景重新执行的声明。 | [accounts_routes](domains/accounts_routes.md) |
| H-CHATGPT-PASS-02 | 第二轮ChatGPT生命周期和UI没有新增确认缺陷 | 历史保留（当前保护链已复核） | renderer当前相关生命周期同哈希，旧10个正常场景保留；没有把这10+1和旧8项后端用例算本轮执行。 | [renderer](domains/renderer.md) |
| H-CHATGPT-OBS-03 | 两次检测之间启动客户端的权限状态修复 | 当前可确认（仍只列观察） | 当前install_clients/platform_network报告仍保留观察，未提升为安装失败或状态损坏。 | [install_clients](domains/install_clients.md) |
| H-CHATGPT-OBS-04 | 人为整轮扫描拒绝导致前端重试整次安装 | 当前可确认（仍只列观察） | renderer当前哈希与入口复核；整次scanSystem人为抛错仍无可证明常见自然触发，不计缺陷，旧10+1未重跑。 | [renderer](domains/renderer.md) |
| H-ACCOUNT-PASS-01 | 账号异步操作56场景无新增明确缺陷 | 当前可确认（保护链；56场景为历史验证） | accounts_routes重读门闩、realm代理及payment-status-reader；旧56结果仅复用，不计本轮执行。 | [accounts_routes](domains/accounts_routes.md) |
| H-N4-SUPPLEMENT | 图片另存缺陷同样影响视频另存 | 当前可确认（N4同根因补充） | 当前canvas_ai报告重读三类另存路径；视频旧ENOSPC对照复用，作品库原资产仍完整。 | [canvas_ai](domains/canvas_ai.md) |
| H-VIDEO-PASS-01 | 历史账号视频生成在UI和两份主进程服务被拒绝 | 当前可确认（客户端保护） | 当前factory/服务拒绝历史账号生成已重读；4次调用0HTTP是旧隔离结果，不是本轮或线上生成。 | [canvas_ai](video-billing.md) |
| H-VIDEO-PASS-02 | 历史账号不会自动借用xm凭据或跨站切线 | 当前可确认（客户端隔离） | 当前coordinator与realm服务根、已有任务GET恢复及CDN无Key链重读；没有发现客户端跨站借用xm分支。 | [canvas_ai](video-billing.md) |
| H-VIDEO-TEXT | 写分镜是文本计费且quota=0不是免费 | 当前可确认（能力和计费边界） | 底层分镜plan为账号文字请求，不能推断免费；历史账号正常视频页入口状态由renderer专项补充，服务器金额未核实。 | [canvas_ai](video-billing.md) |
| H-VIDEO-BILLING | 旧sub2api Grok视频完成后记账可能跳过或失败 | 外部未核实 | 仅旧本地后端/配置条件；不能据客户端复核认定生产扣费。 | [历史来源](video-billing.md) |
| H-VIDEO-EXPLANATION | 钱包不变的正常/配置原因 | 历史保留（解释框架，非故障证明） | 延迟结算、订阅或零价可解释现象，但用户的生产结算配置及账目未核实。 | [历史来源](video-billing.md) |
| H-VIDEO-UPSTREAM | sub2api服务端上游是否被配置成xm未核实 | 外部未核实 | 仅旧本地后端/配置条件；不能据客户端复核认定生产扣费。 | [历史来源](video-billing.md) |
| H-VIDEO-VALIDATION | 视频专项132测试与隔离模拟 | 历史保留 | 原报告结果及限定基线保留；本轮没有同数场景重新执行的声明。 | [canvas_ai](video-billing.md) |
| H-413-FACT | 截图证明HTTP413但具体拦截层待日志确认 | 当前可确认（现场事实；部分仍未知） | 两次均为线路1 入口拒绝的 HTTP POST 413，没有到源站；实际正文大小/客户provider配置仍未知；另一次524独立分析。现场标识不入公开仓库。 | [incident](codex-413-incident.md) |
| H-WS-BEHAVIOR | Codex增量/完整请求与426/HTTP回退 | 当前可确认 | 主域对WebSocket握手回426（有意设置），直连能升级；Codex收到426会在该会话回退HTTP。首次/缓存失效仍可能发完整上下文。 | [incident](codex-413-incident.md) |
| H-WS-GAP-01 | 小型线路探针不能发现独立Codex大请求413 | **部分已修（#1496）** | #1496 已能认出413并自动换线路2或建议新开对话、80MB提前提醒、不自动重放；524识别和检查页端到端状态仍缺。 | [incident](codex-413-incident.md) |
| H-WS-GAP-02 | 配置为true不证明旧会话实际启用WebSocket | **部分已修（#1496）** | #1496 换线后提示重开Codex并核对配置；实际传输方式仍看不出，历史账号托盘释放后换线不出提示（推测）。 | [incident](codex-413-incident.md) |
| H-WS-GAP-03 | 默认WebSocket与HTTP-only验收覆盖不一致 | 当前可确认（P2验收缺口） | incident明确需补101、426回退、重连、缓存丢失及413/524模拟，并单独授权客户真机验收。 | [incident](codex-413-incident.md) |
| H-WS-LIMITS | CF及旧后端大小限制不是现场阈值 | 服务端事实，不入公开仓库 | 各层上限属服务端配置，由维护者私下保留；当前值不能冒充故障当时的完整配置。 | [incident](codex-413-incident.md) |
| H-WS-PLAN | 413处理建议与只读现场复核待办 | 当前可确认（处置建议未执行） | incident建议核对直连与WS配置、完全重启、由客户正常请求验实际101及任务完成；本审查未代发付费请求/改服务器。 | [incident](codex-413-incident.md) |
| H-WS-VALIDATION | 7个离线配置验证不替代现场会话 | 历史保留（当前现场调查另记） | 旧7个离线配置场景不改称本轮；现场只读证据由维护者私下保留，客户切线后的真实完成仍待验。 | [incident](codex-413-incident.md) |

## 本轮新增发现与额外已修记录

以下不混入原 78 项，也不将观察项计为新增确认问题。

| 编号 | 当前结论 | 证据 | 修复方案与验收 |
|---|---|---|---|
| #1407 P2-3 | 当前已修 | 权限卡片与授权一致性：原模块5项正反对照通过。 | [install_clients](domains/install_clients.md) |
| #1407 P2-5 | 当前修复维持；统一单元检查通过 | Windows未知管理员身份默认拒绝；新增3用例全文已读。 | [install_clients](domains/install_clients.md) |
| U01 | 本轮新增确认P2（安全边界） | 本轮隔离界面正反对照确认；抽象影响、修复目标和验收见安全摘要。 | [安全摘要](security-status.md) |
| U02 | 本轮新增确认P2 | 真实controller/lifecycle＋当前main/updater控制流：安装器失败恢复后画布仍永久关闭；普通关重开与新controller对照成功。 | [canvas_ai](domains/canvas_ai.md) |
| U03 | 本轮新增确认P2（测试流程） | 真实harness配离线替身：浏览器启动失败后服务启动1/关闭0；未测真实CI挂起时长。 | [release](domains/release.md) |
| U04 | 本轮新增确认P2（随包脚本） | 真实脚本三个路径在body等待期计时器0且推进后仍pending；MCP对照正确超时，无真实生成。 | [release](domains/release.md) |
| U05 | 本轮新增确认P2 | 原renderer-release与main回调：恢复加载失败后反复打开不再重试；fresh反例及成功对照。 | [core](domains/core.md) |

| U06 | 本轮新增确认P2（开发/浏览器验证） | Node22原开发配置和全新缓存复现依赖混用；生产build模块图未含第二份React，不推断发布包损坏。 | [依赖解析专项](domains/dev-react.md) |

## 覆盖与剩余待办

- 当前已得到结论 78 项；待当前报告 0 项。
- 原 O01/O02/O09 必须依据当前证据，不以历史“已修”标签替代；各自依据见表。
- legacy 普通功能问题遵守冻结策略，不将历史回滚界面的缺陷泛化到当前 v2 界面。
- 历史来源与缺口见 [完整性说明](history-coverage.md)，现场413见 [专项报告](codex-413-incident.md)。
