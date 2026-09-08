# 24 · 旧界面 → 新界面对照（替换用）

现有应用（`src/`，v0.1.31）的每个页面 / 组件在新体系里对应什么。替换时按这张表逐项迁移，**一项不落、一项不多**：旧的功能不能丢，新的界面不能夹带旧样式。

## 1. 页面

| 旧 `PageId` / 组件 | 旧位置 | 新页面 | 新模板 | 变化 |
|---|---|---|---|---|
| `overview` / `dashboard/Dashboard.tsx` + `NextStepsCard` + `RuntimeCell` | 首页 | home | T5 | 工具卡 → 六列列表；NextStepsCard → 开始使用卡（四步 + 路线）；RuntimeCell → 运行环境卡；新增账户余额卡 / 最近卡 |
| `chat` / `pages/AiChatPage.tsx` | 聊天 | chat | 专用 | 布局不变；模型选择带厂商图标；AI 头像换厂商标；错误态按 05 |
| `sessions` / `pages/SessionsPage.tsx` | 记录 | sessions | T3 | 详情改抽屉；筛选带工具图标；归档按 capability |
| `canvas`（独立窗口） | 画布 | canvas | 独立窗口 | 只换 token 与外壳，业务不动 |
| `mcp` / `pages/McpPage.tsx` | 外接工具 | mcp | T1 | 三个方形图标按钮 → 开关 + `···`；新增「常用的一键加」；认证状态按 22 |
| `skills` / `pages/SkillsPage.tsx` | 技能 | skills | T1 | 范围分段；内置星芒技能只读 |
| `plugins` / `pages/PluginsPage.tsx` | 插件 | plugins | T1 | 已安装 / 市场两个视图 |
| `backups` / `pages/BackupsPage.tsx` | 备份 | backups | T1 | 右侧「马上备份」卡；预览改抽屉 |
| `health` / `pages/HealthPage.tsx` | 检查 | health | 专用 | 逐项带「去修」按钮 |
| `maintenance` / `pages/MaintenancePage.tsx` | 安装卸载 | maintenance | 专用 | 两张表 + 安装日志；失败弹窗三种 |
| `feedback` / `pages/FeedbackPage.tsx` | 反馈 | feedback | T1 | 脱敏横幅；客服弹窗带真实二维码 |
| `tutorial` / `pages/TutorialPage.tsx` | 教程 | tutorial | 专用 | 左目录右步骤；进主导航 |
| `updates` / `pages/UpdatePage.tsx` | 更新 | updates | 专用 | 七阶段；联动状态栏 / 通知卡 / 侧栏点 |
| `settings` / `pages/SettingsPage.tsx` | 设置 | settings | T2 | 九组一次一面板；新增关闭行为 / 代理 / 终端 / 通知 / 隐私 |
| `account/AccountCenterPage.tsx` 及 `Account*Panels` | 个人中心（整屏） | account | T2（带侧栏） | 九页签；余额三色；支付图标；头像上传；多账号 |
| `welcome/WelcomePage.tsx` | 欢迎 | welcome | 专用 | 横版 Logo / 四工具胶囊 / 二维码卡 / 首页缩略预览 |
| `onboarding/CodexOnboarding.tsx` + `NodeInstallGuide.tsx` | 首次引导（Codex 桌面端为主） | onboard 向导 | T4 | 六选一不偏向；Node / Python 子步骤；Key 自动写入 |
| `StartupSplash.tsx` | 闪屏 | splash | T4 变体 | 品牌图形标 132 + 四步进度 |
| `config/ConfigDialog.tsx` | 配置弹窗 | Dialog 640 | — | 五页签带图标；来源三选；检测模型；首焦在页签 |
| `account/LoginDialog` / `RegisterDialog` / `ForgotPasswordDialog` | 账号弹窗 | Dialog 480 | — | 滑块验证 / 60s 倒计时 / 三步找回 |
| `SupportDialog.tsx` | 客服 | Dialog 480 | — | 真实二维码 + 复制报告 + 浏览器打开 |
| `Dialog.tsx` / `Toast.tsx` / `StatusMark.tsx` / `ProviderTabs.tsx` | 基础组件 | `Dialog` / `Toast` / `Pill` / `Tabs` | — | 全部由 20 的组件替代，旧文件删除 |
| `AppFrame.tsx` / `Sidebar.tsx` | 外壳 | Shell / Sidebar / Topbar / Statusbar | — | 新增顶栏、状态栏、公告条、告警条、账号卡 |
| `DevelopmentPreview.tsx` | 开发预览 | 组件检阅页 | — | 迁移为 stories |

## 2. 新增（旧版没有的）

顶栏命令面板 ⌘K · 公告（铃铛 / 轮换条 / 弹窗）· 帮助与客服面板 · 底部状态栏 · 全局告警条 × 5 · 右下通知卡 · 首次引导气泡 · 托盘菜单 · 多账号切换 · 深度链接 · 系统通知 · 关闭行为询问 · 快捷键表 · 关于弹窗 · 头像上传 · 异步任务页签 · 用量看板页签 · 安装失败三弹窗。

## 3. 删除（旧版有、新版不要的）

- `design-system/ai/MASTER.md` 及其灰绿配色变量
- `src/styles.css` 全部 650 个 class（新体系不复用任何一条）
- 各页顶部「提示」小字（信息已进页头 lead 与命令面板）
- 「日常 / 加能力 / 维护」文字分组标签（改分割线）
- 首页工具卡上的用量条、命令行字样、双主按钮

## 4. `data-testid` 保留清单

旧 e2e（`e2e/*.mjs`）用到的 testid 全部保留在新组件上；新增 testid 按 `page-component-action` 命名。迁移时先跑 `grep -o 'data-testid="[^"]*"' src -r | sort -u` 生成清单，附在 Phase 0 PR。

## 5. 数据迁移

设置（`settings.json`）、账号存储、会话索引、备份目录：路径不变，字段做兼容读取；新增字段给默认值；首次以 v2 启动时写 `migratedFrom: '0.1.31'`，设置页显示「已从 0.1.31 迁移」并提供回滚（03 / 11）。
