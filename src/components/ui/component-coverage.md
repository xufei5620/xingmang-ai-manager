# UI v3.1.1 组件覆盖

2026-09-07 实码复核。登记按附件 02 的固定编号，尺寸按 01 的 36/32/28。数量是能力登记，不要求产生46个同名封装。下表区分共享组件、业务组合与仍待验证的差异；检阅样例不冒充生产服务结果。共享控件不访问IPC，真实状态由调用方提供。

| 编号 | 组件 | 当前落点与状态 |
|---|---|---|
| V3-001 | Button | `Button.tsx`：主/次/幽灵/危险/强调、三尺寸、处理中保持名称与宽度 |
| V3-002 | IconButton | `Button.tsx`：独立aria-label、Tooltip、三尺寸；焦点/Esc/显隐检查通过 |
| V3-003 | Pill | `Feedback.tsx`：静态状态、可选色点、语义文字 |
| V3-004 | Card | `Layout.tsx`：单对象容器、标题/动作区；选中含义由调用方文字说明 |
| V3-005 | ToolRow | `dashboard/Dashboard.tsx`工具行，真实检测/配置/安装/启动沿旧回调；见primary-views-interactions |
| V3-006 | ListRow | 记录/备份/MCP/技能/插件真实条目组合，详情与变更独立；见management-v3-interactions |
| V3-007 | Tabs | `Selection.tsx`：手动激活、禁用跳过、Home/End、面板关联；显式自动激活；失效选中值仍有键盘入口 |
| V3-008 | Segment | `Selection.tsx`：方向键立即选择、group/pressed、三尺寸；失效选中值仍有键盘入口 |
| V3-009 | Switch | `Choices.tsx`：switch、Space/Enter、标签可点击、busy防重复；保存由调用方负责 |
| V3-010 | Checkbox | `Choices.tsx`：原生input/indeterminate；只读混合态不被点击清除 |
| V3-011 | Radio | `Choices.tsx`：原生 input；调用方提供 fieldset/legend 与 name |
| V3-012 | Input | `Fields.tsx`：标签/错误/提示关联、三尺寸、只读/禁用 |
| V3-013 | Password | `Fields.tsx`：默认遮盖、显隐保持值、pressed 状态 |
| V3-014 | Select | `Fields.tsx`：原生选择和键盘行为 |
| V3-015 | Combobox | `Combobox.tsx`：过滤/选中/禁用/自定义值/IME/方向键/Esc；ConfigDialog模型已接入；Drawer中选择后收起已测 |
| V3-016 | Textarea | `Fields.tsx`：原生换行、纵向调整、受控及非受控计数 |
| V3-017 | FieldError | `Fields.tsx`：错误文本和图标；调用方提交时聚焦首个错误 |
| V3-018 | Tooltip | `Tooltip.tsx`：悬停延迟/聚焦即时/Esc；目标隐藏或被祖先滚动区裁切则收起 |
| V3-019 | Popover | `Popover/Floating.tsx`：外部关闭/返回焦点/top-layer；Tab交还所属模态焦点循环；兼容Dialog及原生Drawer已测 |
| V3-020 | Menu | `Menu.tsx`：上下/Home/End/typeahead/Enter/Space、禁用与危险项；Esc只关闭当前浮层 |
| V3-021 | Dialog | `components/Dialog.tsx`：背景inert/最上层键盘/焦点恢复；ConfigDialog保留父草稿；并非所有旧表单都有dirty确认 |
| V3-022 | Confirm | Key/设备/会话/技能/插件使用业务确认，失败保留确认可重试；保留真实对象与后果 |
| V3-023 | Drawer | `Drawer.tsx`：原生 dialog、420px、避让顶/底栏、背景 inert、焦点返回；记录/备份/MCP/技能/插件详情已接入 |
| V3-024 | Toast | `components/Toast.tsx`成功/信息status，错误alert、可关闭/复制；当前App单条反馈，没有三条并行队列 |
| V3-025 | Notice | `ShellTopbar`通知读取传入快照；公告load/error/retry/空/已读隔离；见shell-navigation-interactions |
| V3-026 | Banner | `Feedback.tsx`：图标/文字/可选动作，可选 polite/assertive 播报 |
| V3-027 | Progress | `Feedback.tsx`：原生 progress，未知值不显示虚构百分比 |
| V3-028 | Skeleton | `Feedback.tsx`：静态骨架、单一 status、装饰隐藏 |
| V3-029 | Empty | `Feedback.tsx`：原因/下一步/可选动作 |
| V3-030 | Error | `Banner tone="bad"` 组合恢复动作；错误脱敏由业务边界负责 |
| V3-031 | Table | 账号用量/任务/订单/Key补table/row/columnheader/cell与表名；详情独立button，保留横滚和固定操作列；真实读屏语义/键盘已测 |
| V3-032 | Pagination | 账号/记录业务分页保留筛选、边界禁用、当前页；未抽泛型组件，未知总量不伪装页数 |
| V3-033 | Filterbar | `Toolbar` 组合 Input/Select；筛选结果与数量由业务负责 |
| V3-034 | DateRange | `DateRange.tsx`：date/datetime，非法日期/顺序/越界提示，保留调用方min/max；账号明细已接入datetime |
| V3-035 | Stepper | `StartGuide.tsx`四步aria-current=step、六路线自选、返回保留草稿；见start-guide-interactions |
| V3-036 | Coachmark | `Coachmark.tsx`：目标可见才显示，跳过/完成/减少动画，隐藏及被父滚动区裁切收起；设置引导入口已接入 |
| V3-037 | Checklist | `StartGuide/SetupCheckItem`读取真实环境状态，已就绪/处理中/失败/待检测区分，不点击即成功 |
| V3-038 | FilePicker | 设置宿主目录选择/取消/保存失败保留草稿；Skill导入仍为路径输入。未提供共享文件拖放上传组件 |
| V3-039 | KeyDisplay | `AccountKeySecretCell`默认遮盖、复制/显隐独立，30秒隐藏，换页/卸载/迟到回包清理；明文不写导航状态 |
| V3-040 | StatsChart | `AccountDashboardPanel`趋势与汇总，根新增可展开逐时段表（时间/合计/各模型）作文本替代；真实口径沿既有服务 |
| V3-041 | CommandPalette | `ShellTopbar` Ctrl/CmdK、IME、方向/Enter/Esc、触发器返回，复用页面注册；见外壳6组回归 |
| V3-042 | Sidebar | `Sidebar.tsx` 216/60、当前页、常驻检查/教程/设置、更多4入口；44x36折叠按钮已测 |
| V3-043 | Accordion | `Layout.tsx`：原生 details/summary |
| V3-044 | Avatar | `Layout.tsx`：文字/图像、身份与状态名称 |
| V3-045 | OTP | 注册/找回单输入变体，one-time-code/numeric/整段输入/退格；注册错误已加aria-invalid/describedby；未引入分格输入 |
| V3-046 | SkinChip | `Choices.tsx`：四皮肤、pressed 状态、稳定宽度；持久化由设置调用方负责 |

辅助布局：`PageHead`、`Toolbar`、`SettingRow`、`Stack`、`Inline`。主题通过 `data-theme`、`data-skin`、`data-reduced-motion` 接入，旧 `--space-*` 未覆盖，新空间尺度为 `--ui-space-*`。

检阅入口：Vite `/src/components/ui/gallery.html`。验证：`npx vitest run src/components/ui/UiPrimitives.test.tsx`；`node src/components/ui/verify-gallery.mjs`。后者验证表单错误/草稿、密码显隐、混合复选、Tabs/Segment 键盘、加载防重复、减少动画、八套明暗皮肤对比度及三种窗口宽度。

本次共享审计新增验证：`npx vitest run src/components/ui --no-file-parallelism` 13项；`node --test e2e/ui-interactions.test.mjs` 8组，覆盖共享交互、四种账号表格、OTP纠错。业务证据另在account-commerce/management-v3/shell-navigation/start-guide/settings/app-v3的交互测试中。

## 未统一项

- FilePicker文件拖放与格式/大小校验无共享产品实现；目前是宿主目录选择与路径导入，不能称为完整上传控件。
- Toast仍是单条反馈，未实现最多3条并行队列。
- dirty确认主要覆盖工具配置，部分旧账户/扩展表单关闭会丢当前草稿，须逐流程补齐；Dialog基础焦点通过不代表完整表单契约完成。
- Windows与八主题基础检查不能替代macOS/Linux真机，也不能证明全部46登记在所有主题与状态组合均已验收。
