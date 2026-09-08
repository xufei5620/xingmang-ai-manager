# 12 · GitHub 实际代码核对与剩余原型问题

2026-09-06，通过用户指定的 GitHub 插件直接读取仓库、main 分支、提交比较和固定提交文件。

**当前核对基准：**[xufei5620/xingmang-ai-manager](https://github.com/xufei5620/xingmang-ai-manager)，默认分支 main，提交 [`0c9ec4a`](https://github.com/xufei5620/xingmang-ai-manager/commit/0c9ec4a5a3c9cf31fa0e05c33725cd31ae73e39e)，[package.json](https://github.com/xufei5620/xingmang-ai-manager/blob/0c9ec4a5a3c9cf31fa0e05c33725cd31ae73e39e/package.json#L1-L7) 版本 **0.1.31**。

上一轮审查使用的本地提交是 `6de7bb961691055f6a318788921fe07f55c70a8c` / 0.1.22。GitHub 比较结果为 **ahead 13、behind 0**，所以本轮以远端固定提交重新核实，不能把上一轮的本地状态继续当作最新产品。附带规格原来写的 0.1.31 与本次远端版本一致；此前把它视为版本不匹配的疑点在此更正。该版本的一致性不代表迁移或安装包已实测。[比较依据](https://github.com/xufei5620/xingmang-ai-manager/compare/6de7bb961691055f6a318788921fe07f55c70a8c...0c9ec4a5a3c9cf31fa0e05c33725cd31ae73e39e)

下列是**源码已核实、UI 原型仍待对齐**的内容。v1.1 已修原型自身的交互、样式和文档问题；没有修改应用源码，也没有把这些业务差异静默变成新需求。所有源码链接固定到同一个提交，读到已有能力不等于线上服务已开启或真机验证通过。

## 应先决定的主流程

| 编号 | 实际代码 | 原型仍有的问题 | 对齐要求 |
|---|---|---|---|
| G01 / 高 | **Codex Desktop 是初始化主线，Node/npm/Codex CLI 为可选。** 桌面检测失败有重试与外部安装恢复；用户选了官方账号时保留其来源。 | 原型欢迎/准备/首页向导仍围绕“装 Node → 装任一 CLI → 写所有工具 Key”。 | 首次引导应表达“检测/安装桌面端 → 按来源准备配置 → 打开”；其他 CLI/运行环境放可选扩展。补桌面已安装、检测失败、用户曾卸载、外部安装、部分准备失败。 |
| G02 / 高 | **注册后尝试自动登录**，成功继续初始化；只有自动登录失败才回登录并预填用户名。 | 原型始终“注册成功，已准备4把Key，请登录”。 | 补自动登录成功、自动登录失败可重试、初始化部分失败三条路径，不无条件承诺注册时已准备全部 Key。 |
| G03 / 高 | 官方来源覆盖 **ChatGPT、Claude、Google**；Grok 不提供官方登录。已有第三方配置是 `unknown`，不能当成普通已配置或随便一键切换。 | 原型仅给 Codex 官方选项，用一个 configured 布尔控制启动；手填 Key 与任意第三方来源混淆。 | 按工具列来源和启动条件，区分未配置、星芒、官方未登录/已登录、第三方需处理；星芒余额不能覆盖官方额度状态。 |
| G04 / 高 | **Codex CLI 与桌面端共用配置**。官方/中转切换保存和恢复整份来源档案，并处理桌面重启。 | 两个原型工具对象独立维护 source/key/model，修改一张卡不会可靠同步另一张；来源切换统一显示“Key 已写入”。 | 两个入口标注共用配置并同步展示；补切换确认、配置已切换但重启失败；官方模型由 Codex 窗口选择。 |

证据：G01 [onboarding-flow.ts:106](https://github.com/xufei5620/xingmang-ai-manager/blob/0c9ec4a5a3c9cf31fa0e05c33725cd31ae73e39e/src/onboarding-flow.ts#L106-L179)、[CodexOnboarding.tsx:220](https://github.com/xufei5620/xingmang-ai-manager/blob/0c9ec4a5a3c9cf31fa0e05c33725cd31ae73e39e/src/components/onboarding/CodexOnboarding.tsx#L220-L258)；G02 [App.tsx:1305](https://github.com/xufei5620/xingmang-ai-manager/blob/0c9ec4a5a3c9cf31fa0e05c33725cd31ae73e39e/src/App.tsx#L1305-L1347)；G03 [account-source.ts:14](https://github.com/xufei5620/xingmang-ai-manager/blob/0c9ec4a5a3c9cf31fa0e05c33725cd31ae73e39e/src/account-source.ts#L14-L110)；G04 [provider-meta.ts:69](https://github.com/xufei5620/xingmang-ai-manager/blob/0c9ec4a5a3c9cf31fa0e05c33725cd31ae73e39e/src/provider-meta.ts#L69-L70)、[来源确认](https://github.com/xufei5620/xingmang-ai-manager/blob/0c9ec4a5a3c9cf31fa0e05c33725cd31ae73e39e/src/components/config/OfficialAccountDialog.tsx#L33-L63)、[重启结果](https://github.com/xufei5620/xingmang-ai-manager/blob/0c9ec4a5a3c9cf31fa0e05c33725cd31ae73e39e/src/components/config/ConfigDialog.tsx#L548-L577)。

## 必须保留的页面内能力

| 编号 | 源码已核实的能力 | 原型需要补什么 |
|---|---|---|
| G05 / 高 | 官方 ChatGPT 登录邮箱、套餐、续期、额度窗口、重置时间/次数，及刷新条件。 | 独立官方额度面板、未登录/无可用信息/刷新中/失败状态；不能拿星芒余额替代，也不能把未知额度当零。 |
| G06 / 高 | 已有配置保存支持“只修改 Key 和模型，保留自定义配置”与“重置初始配置”；已运行 Codex 有“打开窗口/重启”。 | 本次已修草稿保留，但业务上的合并/重置和打开/重启选择仍需要原型位置与确认内容。 |
| G07 / 高 | Key 新建及编辑都支持无限/自定义美元额度、具体到期日期；状态包括启用、禁用、过期、额度用尽。 | 补额度、有效期编辑、四状态及对应动作。实际明文自动隐藏为30秒，原型15秒若保留应明确为有意变更。 |
| G08 / 高 | 个人中心有独立“用量看板”和“调用明细”，看板有24小时/7天/30天、消费、趋势/占比/排行、Token、RPM/TPM。 | 新增看板入口和对应加载、无数据、失败、结果截断提示；明细表和三张摘要卡不能替代。 |
| G09 / 中 | 技能/插件按 Provider 管理，启停和操作受 capability 约束；MCP 还有 OAuth/Bearer 配置与登录/退出。 | 补工具切换、可用/不可用原因、系统只读、启停，以及 MCP 授权过程和结果。 |
| G10 / 中 | 内置“星芒AI”技能用于生成/编辑图片，安装与登录会联动；Codex 切官方后停用，回星芒后恢复。 | 原型里同名“余额/Key 管理插件”不是这个能力；应补内置技能的待配置、就绪、因来源停用状态，并说明来源切换影响。 |
| G11 / 中 | 归档/恢复仅限满足能力条件的 Codex 会话；配置备份按工具有准确文件清单；仅 Codex 技能走回收站。 | 别对所有工具显示同样的归档/回收承诺；备份补 Grok、Gemini .env，纠正 Claude 的额外文件范围。 |

证据：G05 [桌面官方状态](https://github.com/xufei5620/xingmang-ai-manager/blob/0c9ec4a5a3c9cf31fa0e05c33725cd31ae73e39e/src/components/dashboard/CodexDesktopCard.tsx#L116-L159)、[额度组件](https://github.com/xufei5620/xingmang-ai-manager/blob/0c9ec4a5a3c9cf31fa0e05c33725cd31ae73e39e/src/components/dashboard/OfficialChatGptMeter.tsx#L22-L77)；G06 [保存模式](https://github.com/xufei5620/xingmang-ai-manager/blob/0c9ec4a5a3c9cf31fa0e05c33725cd31ae73e39e/src/components/config/SaveModeDialog.tsx#L19-L41)、[启动选择](https://github.com/xufei5620/xingmang-ai-manager/blob/0c9ec4a5a3c9cf31fa0e05c33725cd31ae73e39e/src/components/config/CodexLaunchDialog.tsx#L50-L69)；G07 [KeyEditor](https://github.com/xufei5620/xingmang-ai-manager/blob/0c9ec4a5a3c9cf31fa0e05c33725cd31ae73e39e/src/components/account/KeyEditorDialog.tsx#L175-L207)、[状态](https://github.com/xufei5620/xingmang-ai-manager/blob/0c9ec4a5a3c9cf31fa0e05c33725cd31ae73e39e/src/components/account/account-center.ts#L120-L135)、[隐藏时长](https://github.com/xufei5620/xingmang-ai-manager/blob/0c9ec4a5a3c9cf31fa0e05c33725cd31ae73e39e/src/components/account/AccountCenterPage.tsx#L57)；G08 [看板](https://github.com/xufei5620/xingmang-ai-manager/blob/0c9ec4a5a3c9cf31fa0e05c33725cd31ae73e39e/src/components/account/AccountDashboardPanel.tsx#L179-L236)；G09 [技能](https://github.com/xufei5620/xingmang-ai-manager/blob/0c9ec4a5a3c9cf31fa0e05c33725cd31ae73e39e/src/pages/SkillsPage.tsx#L339)、[插件](https://github.com/xufei5620/xingmang-ai-manager/blob/0c9ec4a5a3c9cf31fa0e05c33725cd31ae73e39e/src/pages/PluginsPage.tsx#L389-L457)、[MCP OAuth](https://github.com/xufei5620/xingmang-ai-manager/blob/0c9ec4a5a3c9cf31fa0e05c33725cd31ae73e39e/src/pages/McpPage.tsx#L185-L199)、[授权动作](https://github.com/xufei5620/xingmang-ai-manager/blob/0c9ec4a5a3c9cf31fa0e05c33725cd31ae73e39e/src/pages/McpPage.tsx#L496-L501)；G10 [技能用途](https://github.com/xufei5620/xingmang-ai-manager/blob/0c9ec4a5a3c9cf31fa0e05c33725cd31ae73e39e/bundled-skills/xingmang-ai/SKILL.md#L2-L13)、[联动](https://github.com/xufei5620/xingmang-ai-manager/blob/0c9ec4a5a3c9cf31fa0e05c33725cd31ae73e39e/electron/system-service.ts#L3463-L3487)；G11 [会话能力](https://github.com/xufei5620/xingmang-ai-manager/blob/0c9ec4a5a3c9cf31fa0e05c33725cd31ae73e39e/src/pages/SessionsPage.tsx#L202-L209)、[备份清单](https://github.com/xufei5620/xingmang-ai-manager/blob/0c9ec4a5a3c9cf31fa0e05c33725cd31ae73e39e/electron/config-files.ts#L117-L131)、[卸载差异](https://github.com/xufei5620/xingmang-ai-manager/blob/0c9ec4a5a3c9cf31fa0e05c33725cd31ae73e39e/src/pages/SkillsPage.tsx#L160-L166)。

## 金额、订单和账号不能只按示例数据设计

**G12 / 高：金额和统计口径。** 账户余额、Key 额度、调用费用使用 quota 与 quotaPerUnit 转美元；小额调用费保留更多精度。原型还以 ¥ 展示示例余额/消费，且把某个累计使用量直接解释成“本月已用”、估计剩余天数。应明确账户计价币种、订单实付币种、订阅币种、汇率与统计区间；未知/暂不可得用“—”，不能补成0或编造预计天数。本次只修了“确认窗保留选择”，没有把所有金额自行换成另一币种。[金额格式](https://github.com/xufei5620/xingmang-ai-manager/blob/0c9ec4a5a3c9cf31fa0e05c33725cd31ae73e39e/src/components/account/account-stub.ts#L60-L72)、[小额精度](https://github.com/xufei5620/xingmang-ai-manager/blob/0c9ec4a5a3c9cf31fa0e05c33725cd31ae73e39e/src/components/account/account-center.ts#L112-L117)、[余额数据](https://github.com/xufei5620/xingmang-ai-manager/blob/0c9ec4a5a3c9cf31fa0e05c33725cd31ae73e39e/electron/new-api-client.ts#L2313-L2327)

**G13 / 高：充值和订阅分开建流程。** 充值方法由服务端下发，部分支付返回 POST 表单；订阅还支持余额、Epay、Stripe、Creem、Waffo Pancake，并依站点/计划开关显示。不能说“实际应用只支持 Stripe/Creem”。实际等待时限为10分钟，原规范30分钟不是当前行为。还要补最低额、报价中/失效、折扣、实付确认、无可用渠道、窗口已关但订单待核实、查询失败/超时及继续查询。到账以服务端订单查询结果为准；金额/方式/报价应保持同一快照，报价改变时不能沿用旧确认结果。这里是 UI 验收要求，没有执行真实支付或复现线上错误。[支付方式与时限](https://github.com/xufei5620/xingmang-ai-manager/blob/0c9ec4a5a3c9cf31fa0e05c33725cd31ae73e39e/src/components/account/AccountCommercePanels.tsx#L42-L87)、[充值表单](https://github.com/xufei5620/xingmang-ai-manager/blob/0c9ec4a5a3c9cf31fa0e05c33725cd31ae73e39e/electron/new-api-client.ts#L1187-L1213)、[订阅支付形式](https://github.com/xufei5620/xingmang-ai-manager/blob/0c9ec4a5a3c9cf31fa0e05c33725cd31ae73e39e/electron/new-api-client.ts#L1424-L1448)

**G14 / 中：多订阅与四种扣费偏好。** 当前可有多条订阅、各自额度/到期/状态和购买次数限制；扣费偏好有第四项“仅使用订阅”。原型单个 user.plan 与两档套餐只是示例，不能作为最终模型；需补多订阅列表、无活跃订阅时不可选项与购买上限。[实际订阅面板](https://github.com/xufei5620/xingmang-ai-manager/blob/0c9ec4a5a3c9cf31fa0e05c33725cd31ae73e39e/src/components/account/AccountCommercePanels.tsx#L741-L797)

**G15 / 中：多账号是新增能力。** 当前应用只有单会话和单个 account-session.dat；已有登录设备管理不代表支持本机多账号切换。原型的账号列表、添加另一账号、切换后重写工具配置要单独标为新增。补目标账号失效、切换中、部分工具未切换、旧账号付款/聊天稍后完成等状态。记住密码、启动恢复、登录过期与网络失败也需要分开描述；不要自行把认证数据类型写成 access token。[单会话](https://github.com/xufei5620/xingmang-ai-manager/blob/0c9ec4a5a3c9cf31fa0e05c33725cd31ae73e39e/electron/new-api-client.ts#L2075-L2085)、[单凭据文件](https://github.com/xufei5620/xingmang-ai-manager/blob/0c9ec4a5a3c9cf31fa0e05c33725cd31ae73e39e/electron/main.ts#L705-L711)、[会话恢复](https://github.com/xufei5620/xingmang-ai-manager/blob/0c9ec4a5a3c9cf31fa0e05c33725cd31ae73e39e/electron/main.ts#L739-L764)

**G16 / 中：找回密码与认证政策。** 当前发送重置邮件用 GET `/api/reset_password?email=…`；输入框 trim 后提交 token，没有整条重置链接自动提取。新密码显示/复制/去登录已经存在，应保留。原型的整链接解析、客户端滑块、固定锁定次数/时长、用户名查重等要分别注明待实现交互或服务端政策，不能作为已验证契约。客户端交互不能代替服务端认证校验。[实际请求](https://github.com/xufei5620/xingmang-ai-manager/blob/0c9ec4a5a3c9cf31fa0e05c33725cd31ae73e39e/electron/new-api-client.ts#L2215-L2224)、[输入处理](https://github.com/xufei5620/xingmang-ai-manager/blob/0c9ec4a5a3c9cf31fa0e05c33725cd31ae73e39e/src/components/account/ForgotPasswordDialog.tsx#L126-L132)

## 桌面与规范接入边界

**G17 / 中：平台与新系统能力。** 当前 Node/Python 仅 Windows 托管安装；Codex Desktop 安装/卸载/微软商店入口也受平台条件控制。macOS 外部安装后的重新检测应有对应界面。托盘、外部深链、系统主题/代理/通知等需逐项登记已有实现与新增范围。特别是代码里的 `registerFileProtocol('xingmang')` 是内部页面文件协议，不能据此认定浏览器 `xingmang://pay/...` 已完成外部唤起和订单回调。当前主窗口关闭会关闭付款与画布窗口；加入托盘后要重新定义后台任务和窗口生命周期。[平台能力](https://github.com/xufei5620/xingmang-ai-manager/blob/0c9ec4a5a3c9cf31fa0e05c33725cd31ae73e39e/electron/platform-capabilities.ts#L38-L50)、[内部协议](https://github.com/xufei5620/xingmang-ai-manager/blob/0c9ec4a5a3c9cf31fa0e05c33725cd31ae73e39e/electron/main.ts#L214-L222)、[关闭生命周期](https://github.com/xufei5620/xingmang-ai-manager/blob/0c9ec4a5a3c9cf31fa0e05c33725cd31ae73e39e/electron/main.ts#L1173-L1180)

**G18 / 中：“所有设置即时保存”是行为变更。** 当前除主题外的工作目录、启动检测、服务器、下载来源等有草稿与显式保存，并保护未保存值。原型改成所有选项即时保存，需要定义写入中、失败回退、重复点击、重启生效和离页时保存状态，不能只用“已保存”toast模拟完成。原型新增的大量设置项也不等于当前已支持。[草稿保护](https://github.com/xufei5620/xingmang-ai-manager/blob/0c9ec4a5a3c9cf31fa0e05c33725cd31ae73e39e/src/pages/SettingsPage.tsx#L54-L70)、[保存入口](https://github.com/xufei5620/xingmang-ai-manager/blob/0c9ec4a5a3c9cf31fa0e05c33725cd31ae73e39e/src/pages/SettingsPage.tsx#L140-L155)

**G19 / 中：已有设计规范要建立替代关系。** 远端新增了 design-system/ai/MASTER.md，使用石墨灰、绿色状态色和较少装饰的风格，和本包 Starlight Gold 存在明确差异。用户可以决定新规范替代旧规范，但接入时应列旧Token→新Token、共用组件、画布与主窗口的适用范围和截图基准；仅写“旧的作废”不能保证剩余页面同步。[当前仓库设计规范](https://github.com/xufei5620/xingmang-ai-manager/blob/0c9ec4a5a3c9cf31fa0e05c33725cd31ae73e39e/design-system/ai/MASTER.md#L9-L43)

Codex 中文界面、工作区信任、基础官方账号选项在原型中原本就有；准确缺口是检测中/不可用/失败与重启结果，不应重复报成整项缺失。[语言与工作区界面](https://github.com/xufei5620/xingmang-ai-manager/blob/0c9ec4a5a3c9cf31fa0e05c33725cd31ae73e39e/src/components/config/ConfigDialog.tsx#L915-L979)

## 下一版 UI 原型的工作清单

优先 G01–G04，统一注册后进入、桌面初始化、凭据来源和共享配置；随后补 G05–G14 已有功能。G15–G18 的新增或改变行为需明确范围及服务端/平台能力后才能视为可交付。G19 随前端规范接入处理。

建议每条业务项记录：实际代码入口、原型页面/状态、保留或改变的行为、操作前条件、成功/失败结果、待实现范围、验收依据。本包已经修好的独立 UI 项见 `13-revision-validation.md`，不要把它们与这里尚未对齐的业务项混为一份“全部完成”清单。
