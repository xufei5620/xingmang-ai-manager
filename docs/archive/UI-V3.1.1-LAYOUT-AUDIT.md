# UI v3.1.1 排版对照审计

日期：2026-09-07。范围：已核验的 `ui-spec/prototype/星芒AI管理工具-可交互原型.html` 及其最终模块（`98-restore`、`99-skin`），对照当前 React/Electron 页面。本文只记录排版、资源和页面结构差异，不把原型的模拟状态当成产品能力。

## 证据基线

- 原型入口：`.project-surgeon/audits/20260906-ui-plan/input/v311/ui-spec/prototype/星芒AI管理工具-可交互原型.html`
- 最终模块顺序：原型加载后执行 `10-onboarding.js`、`20-account.js`、`40-tools.js`、`80-maintenance.js`，再由 `98-restore.js`、`99-skin.js` 覆盖拍板视觉。
- 当前主题/窗口基线：`src/main.tsx` 导入 `styles.css`、`styles/ui-tokens.css`、`styles/ui-layout.css`；页面组件再导入自己的局部 CSS。
- 原型使用 `TOOL_ORDER_ALL = ['claude', 'codex', 'codexDesktop', 'gemini', 'grok']`（Linux 去掉桌面端）。

## P0：应先修的结构差异

| 页面 | 原型最终选择器/尺寸 | 当前源码/选择器 | 偏差与执行项 |
|---|---|---|---|
| 欢迎 | `.welcome`：1440 视口内层约 `1160px`，`.hero` 两列 `546px / 574px`、gap `40px`；`.brandline img` 高 `128px`；`.preview .frame` 为右侧工作台预览；`98-restore.css` 明确保留横版 128px Logo。 | `src/components/welcome/WelcomePage.tsx`；`.welcome-v3 .welcome-content` 最大 `1320px`、padding `28px 40px`；`.welcome-brand-logo` 42px + `.welcome-brand-wordmark` 102px；右侧为自绘 `.welcome-constellation`。 | Logo 和 Hero 结构不是原型最终排版。改为品牌包横版 Logo（亮/暗变体）高 128px，Hero 采用 1fr/1fr（最大 1160px）两列；右侧保留 `.preview` 无框工作台预览，并把星轨放进其预览区域。当前星轨 canvas 可复用作背景，但不能替代预览容器结构。 |
| 欢迎 | `.welcome .foot` 四列：3 个 `.card.feat` + 1 个 `.card.support`，1440 下约 `272 / 272 / 272 / 309px`，gap `12px`；support 最小宽 `300px`。 | `WelcomePage.tsx` 只有 `.welcome-cards3` 三列，客服在独立 `.welcome-foot`；`.welcome-v3 .welcome-cards3` 只覆盖三项。 | 将客服纳入同一底部四列网格，统一基线和垂直间距；不把客服二维码拆到另一行。保留当前真实 QR 和客服回调。 |
| 首页 | 原型 `.home-grid`：`grid-template-columns: minmax(0, 690px) minmax(280px, 292px)`，gap `18px`；左栏按 `.card.tools`（已安装）/`.card.tools`（还可以装）/`.card.rows`（最近）分组；右栏依次环境、账户、提示。 | `src/components/dashboard/Dashboard.tsx` + `dashboard-v3.css`：`.dashboard-workspace` 主栏/侧栏 `1fr / 248px` gap `24px`；`.dashboard-tool-entry` 去卡片化为平铺边线行；安装缺失工具与已安装工具混在同一 table。 | 恢复原型两栏与分组卡片：已安装、可安装、最近记录各自有标题和边界；右栏宽约 292px。不要以单个全局六列 table 替代两个工具区。 |
| 首页 | 原型 `.trow` 列轨固定 `40px 200px 160px 72px 92px 32px`，顺序为品牌、名称/版本、状态、更新、主动作、更多；版本和模型位于 `.name` 子行。 | `dashboard-v3.css` `.dashboard-tool-row` 是 `minmax(156px,1.4fr) minmax(92px,.8fr) minmax(96px,.9fr) minmax(80px,.75fr) 104px 72px`，表头顺序“工具/版本/来源/状态/操作/更多”。 | 列轨和 DOM 语义偏离原型。改成共享固定列轨；名称列内显示版本/模型，状态列显示 Key/官方/余额状态，更新列只显示更新动作；更多按钮命中区 32px。仍保留真实状态拆分，不照搬模拟文案。 |
| 首页 | 原型工具顺序 `claude → codex → codexDesktop → gemini → grok`；快捷键按该顺序编号。 | `src/provider-registry.ts` `dashboardProviderIds = codex, claude, grok, gemini`，`Dashboard.tsx` 另把桌面端固定放最前。 | 新版列表顺序必须改为 `TOOL_ORDER_ALL` 的产品顺序；快捷键和 `resolveLaunchableProvider` 同步改序。Provider 注册表测试需更新证据，不能破坏管理页既有顺序。 |
| 账号 | 原型 `.xm-account`：page padding `28px 32px 40px`；顶部 `.page-head` + 9 页签 `.tabs`，页签高度约 42–47px，可换行；overview `.xm-profile` 两列 `1fr / 280–340px`；右列账户余额和“已保存账号”卡。 | `src/components/account/AccountCenterPage.tsx` 使用 `.account-center-layout` 左侧导航 `170px` + 主内容；`src/styles.css` `.account-center-navigation`、`.account-center-subtabs` 为另一套内嵌导航；保存账号切换器是独立 Dialog。 | 主页面排版不是原型的顶部九页签。将 9 个 primary tab 放在页面标题下同一横向/可滚动页签带，overview 内部保留 profile/安全二级页签；余额与保存账号摘要进入右列。AccountSwitcher 仍可作为受控模态入口，不要把它再嵌成第三层卡片。 |
| 设置 | 原型 `.settings-grid`：`160px 816px`（1440 视口，内容内层 1000px），左 `.subnav`，右 `.settings-group`，设置行 `.setting` padding `13px 16px`；最终 8 组。 | `src/pages/SettingsPage.tsx` + `settings-page.css`：`172px + 820px`、gap `32px`；每行 padding `18px 0 4px`，部分内容仍以 page 级无卡片方式呈现。 | 冻结为 160px/右侧 minmax 的两列，设置行采用原型 13px/16px 内间距与分隔线，保留八组单面板和逐字段保存。皮肤芯片位置应在“主题”后同一行，不额外制造卡片。 |

## P1：品牌和密度对齐

| 页面 | 原型证据 | 当前问题 | 执行项 |
|---|---|---|---|
| 欢迎 | `98-restore.js` `.xm-welcome-copy`、`.xm-welcome-links`、`.legal`；`98-restore.css` h1 `42px/1.12`，品牌金-浅蓝渐变。 | 当前 `.welcome-title` 38px/1.25，正文和按钮间距由 `welcome-v3.css` 重新定义；导航另加“帮助”图标和“已保存账号”文字入口，原型欢迎页没有这两个并列项。 | 标题恢复 42px/1.12，副文案宽度和链接行按原型；已保存账号入口移到登录后的账号区域，欢迎页只保留登录、创建账号、教程、减少动画、协议/隐私和客服。 |
| 欢迎 | `99-skin.js`/`99-skin.css`：`.orbit-scene` 高 `460px`，`.orbit-ring.r1` `220px`、`.r2` `340px`，中心 `.orbit-core` 150px，底部 `.orbit-hud`。背景 canvas 有地平线光晕、星座连线、流星。 | 当前 `.welcome-constellation` 最大 420px、轨道 52%/82%，中心 128px；`WelcomeStarfield.tsx` 只有 72 个矩形星点，无地平线/连线/流星。 | 使用原型尺寸和轨道速度（18s/32s 反向）；星芒中心引用真实 SVG；背景补地平线光晕、连线和减少动画静态帧。任何 `ENV OK`、`KEY 4/4 SYNCED` 只可在真实回执存在时显示。 |
| 账号 | 原型 `.xm-account .tabs a` padding `12px 13px`、min-height `42px`；`.xm-account .xm-state` min-height `230px`；`.xm-account .xm-metrics .stat` min-height `105px`。 | 当前 account tabs 有多层 `.account-center-tabs`/`.account-center-subtabs` 旧样式，统计和空态尺寸按旧 CSS。 | 只保留一套 v3 变量覆盖，统一页签、空态、统计行尺寸；内容区仍可滚动，表格自身横向滚动。 |
| 设置 | 原型 `.settings-grid .subnav button` min-height `32px`，活动态 `panel-2`；`.setting .r` 不压缩成窄控件。 | 当前 `.settings-v3-nav button` 36px，右控件最大宽度受 `max-width:100%`，窄窗容易把说明和控件挤在同一行。 | 采用 32px 导航行、右侧控件不小于 188px；小窗口改为上下布局，保证说明和保存反馈不重叠。 |

## P2：应纳入集成验收的顺序和状态

- 首页必须按产品顺序渲染 5 个工具；Linux 隐藏桌面端但不改变其余顺序。
- 首页已安装/可安装/最近三块的卡片标题、状态和主动作应来自真实 `SystemSnapshot`、`AppConfigSummary` 和会话数据；不能显示原型里的固定“已配好”“Key 已自动写入 2 个工具”。
- 账号九页签顺序固定：我的账号、用量看板、密钥、调用明细、异步任务、充值与订阅、我的订单、邀请返利、登录设备。
- 设置固定八组：外观、启动与关闭、工具、网络、通知、账号、隐私与数据、关于；只渲染当前组内容。
- 四套皮肤（晨曦金、极夜黑金、雾青、极光紫）需要在首页、账号、设置和欢迎页分别检查；皮肤切换不改变上述列轨和页面层级。
- 原型使用的示例余额、任务、订单、Key、公告和环境状态只用于排版参照；产品必须使用真实回执或显示“暂未获取”。

## 分配建议

1. 欢迎：`WelcomePage.tsx`、`WelcomeStarfield.tsx`、`welcome-v3.css`；先恢复横版 Logo、四列 footer 和 `.preview/orbit-scene` 结构，再调背景动画。
2. 首页：`Dashboard.tsx`、`CliToolRow.tsx`、`dashboard-v3.css`、`provider-registry.ts`；先冻结工具顺序和两栏/三卡结构，再迁移状态列。
3. 账号：`AccountCenterPage.tsx` 及账号局部样式；把九页签提升到标题下，复用现有业务 panel，不把切换器和余额摘要重复嵌套。
4. 设置：`SettingsPage.tsx`、`settings-page.css`；冻结 160px/右侧列轨和 13/16 行间距，保留逐项保存状态。

## 不应从原型直接复制的内容

- 不复制固定 `ENV OK`、`KEY 4/4 SYNCED`、优惠/工作时间、模拟余额和“自动撤回”结果。
- 不把原型的 `A.*` 事件、定时器状态机或演示 JSON 当作 IPC/业务实现。
- 不恢复原型旧版的“Claude 推荐”或登录后自动安装；当前产品决策是六选一、用户明确触发准备。
- 不恢复签名发布要求；发布仍保持无签名模式。
