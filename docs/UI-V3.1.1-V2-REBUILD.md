# UI v3.1.1 renderer-v2 本地重建记录

状态：0.1.32 源码合并候选。产品负责人已明确授权创建 PR 并合并；本轮不构建或发布安装包。所有新增代码为 UTF-8，无 BOM。

## 依据与边界

按 CLAUDE.md §0、HANDOFF、一页纸、旧新对照、阶段文档执行。最终视觉基线为 `ui-spec/prototype/星芒AI管理工具-可交互原型.html`，SHA-256：`eb8f18a299c345e26cc5705e5d06fcb2972faeb890b0e23bc9f326d30d9b4aa6`。包内较旧的欢迎页缩略工作台不作为最终依据；当前欢迎页为星轨场景。

- `src/renderer-v2/` 从零建立。旧 `src/` 保留为只读回滚与功能核对；运行时 AST 和 Vite 产物检查禁止新版导入旧 UI。
- 既有 Electron 业务、IPC 和 canvas 工作流逻辑保留；本轮仅在明确接入点补充关闭竞态、账号所有权边界、受控编辑同步和 canvas token 加载顺序。package main、Vite、tsconfig 与 `electron/platform/` 负责 v2 启动和平台能力。
- React/ReactDOM 19.2.8；类型 19.2.18/19.2.7；@lobehub/icons 5.18.0、simple-icons 16.30.0、Lucide 0.468.0。旧回滚渲染层独立保留 React 18.3.1，Vitest 的 SSR 也分项目隔离。
- 1280 逻辑宽，216/60 侧栏、46 顶栏、30 状态栏；整体缩放按 DIP 计算，不使用响应式断点。
- Windows 无签名发布保持原状。没有安装包发布、证书轮换、CN 或 Subject 要求。

## 实施进度

| 范围 | 本地状态 | 证据 |
|---|---|---|
| 依据与注册表 | 已建立 | 原型 360 张实际截图，200 个明确不适用的状态；原型脚本 13/13 通过 |
| 组件与外壳 | 已实现 | 组件检阅页；暗亮材质 16 组比较差异 0；键盘、dirty、Popover、Tooltip、Coachmark 检查 |
| 欢迎、认证、引导 | 已接入原 IPC | 六路线无默认选择；Gemini Node/Python/CLI 分步；注册后真实登录；恢复按账号隔离 |
| 工具与配置 | 已接入原 IPC | 登录/注册/会话恢复后同步托管 Key，按已安装工具写入并回读；新版手填来源、官方及第三方配置保留；CLI/桌面分派、实时安装状态、官方额度、独立重启 |
| 账号与业务页面 | 已实现 UI 与现有契约接入 | 九页签、支付回跳只查询、可选 CLI 同步、会话/扩展/备份/维护/设置 |
| 聊天 | 已接入原服务 | 文本流、推理、图片、重试/编辑/停止、历史、切页继续、账号隔离、关闭保护 |
| 平台 | Windows 部分真机验证 | 独立 preload、主题、高对比、缩放；自启动与系统通知仍区分开发模式和系统能力 |
| 画布 | 引擎保留，v2 token 接入 | v2 构建无旧 UI 样式导入；React 19 下 498 项画布测试已通过 |
| 完整验收 | 未完成 | 逐页人工视觉审阅、Mac 原生验证、现有服务缺口仍需明确 |

## 入口

- `npm run dev`：默认启动新界面，画布也按 v2 token 构建；`npm run dev:v2` 保留为同义入口。
- `npm run compile` 后 `npm start`：默认新版构建带 renderer-v2.flag，原生平台接入不依赖启动时再次设置环境变量；`npm run compile:v2` 保留为同义入口。
- `npm run dev:legacy` / `npm run compile:legacy`：仅在显式回滚时启动或构建 React 18 旧界面。没有删除旧源码或旧数据。
- `src/renderer-v2/gallery.html`：组件检阅。
- `node e2e/prototype-reference-capture.cjs`：在本地生成当前原型截图。
- `node e2e/prototype-reference-capture.cjs && node e2e/v2-business-screenshots.mjs && node e2e/renderer-v2-evidence-index.mjs`：在本地依次生成原型截图、实现截图和可筛选矩阵；生成的 PNG、清单与索引不进入源码 PR。
- v2 首次启动首帧使用亮色主题与雾青皮肤；没有已保存皮肤时设置页和运行时均回退到雾青，用户已保存的主题/皮肤优先保留。状态栏的来源位置显示主进程扫描得到的国家/地区与公网 IP，探测失败显示“网络位置未知”。

## 已验证

- `node ui-spec/work/run-final-checks.cjs`：13 组全部通过，原型与 integration hash 相同，源文件未改变。
- `npm run check:v2`：旧产品 43 处 testId、19 个模式；0 确定缺失；5 个引导 ID 为动态模板候选，并有实际浏览器验证。旧 UI / Node 内置运行时导入为 0。
- `npm run typecheck`：通过，包含旧渲染、新渲染、主进程和主进程测试类型。
- `npm run compile:v2`：通过，主渲染与画布产物检查通过。
- `npm run test:v2`：113 项单元测试、86 组浏览器测试全部通过。登录自动写 Key、通用邮箱注册/找回、恢复缺失配置、手填来源保护、同步进度锁定、部分失败重试、新装工具单项配置、账号切换保持可选同步均有整应用覆盖。
- `node e2e/renderer-v2-native.mjs`：Windows 原生隔离临时 profile；960/1280/1440 内容宽分别 zoom 0.75/1/1.125，1280 逻辑宽；preload 可用；高对比/主题重新加载后保留；星空 canvas 非空，页面错误 0。没有修改用户账号或安装目录。
- `node e2e/renderer-v2-component-surface-check.mjs`：16 组暗亮按钮/卡片/字段/状态样式比较，差异 0。
- `electron/new-api-notice-real-shape.test.ts` 与公告组件测试覆盖生产约 2.42 MB 富 HTML、旧 envelope、脚本/样式/内联 SVG 过滤和超限回退；公告读取只对该公共接口使用 4 MB 上限，其他接口仍为 512 KB。
- `node e2e/canvas-editor-smoke.mjs`：4 个窗口尺寸、125%/150% 缩放、检查器/下拉菜单、拖拽吸附、`@` 素材菜单、撤销重做和 100 节点压力场景通过；无横向溢出、页面错误或外部请求。
- 画布关闭在 React 回执尚未安装、preload/主帧加载失败或 renderer 崩溃时均 fail-open；账号切换会取消旧 owner 任务，聊天凭据 in-flight 按 session revision 隔离，取消运行/生成请求按当前账号校验。
- `node e2e/v2-business-screenshots.mjs`：本地生成 240 张，包含真实 Shell 的业务页与账号页签，暗/亮 × Win/Mac 样式 × 默认/空/失败；无脚本错误或横向溢出。设置等无自然空态的页面保持真实正常内容；图片按产品负责人要求不进入源码 PR。
- 新渲染与平台 150 个源码/样式/说明文件编码检查无 BOM、无无效 UTF-8。

全仓 `npm test` 的 Vitest 部分：3001 通过、4 失败、160 跳过。4 个失败是已有 Windows 符号链接 EPERM：backups 1、path-identity 1、safe-local-data 2。没有跳过或放宽这些断言。

另行运行 `npm run test:node`：脚本测试 100/100 通过、前置业务浏览器组 20/20 通过；旧 UI 浏览器 61/62 通过。旧 `shell-navigation-interactions` 的延迟列表返回滚动恢复在干净 HEAD 93033e6、React/ReactDOM 18.3.1 下同样于原第112行失败；脱敏复核证据留在本地，不进入源码 PR。已确认是既有失败，未修改旧源码或断言。新版采用页面缓存与独立滚动记忆，并验证聊天跨页任务保留。

## 规范差异与未完成能力

- 冻结颜色、品牌资产和尺寸没有另创设计。原型样式中的阴影值提取为本地语义别名。20 文档焦点色写 --accent，当前原型实际为 --info；按用户“视觉与交互以原型为准”的规则采用原型的 --info 外环。
- 头像选择/裁剪已实现，按 HTTPS origin + userId 保存在本机并同步侧栏；不会伪称上传到账户服务器。服务器头像接口不存在。
- 新版手动保存的同域 Key 会按 relay origin + Provider 记录本机来源标记，自动初始化不会覆盖；Codex CLI 与桌面端共享标记。升级前已经存在的同域手填配置没有历史来源信息，无法可靠追溯，首次显式重新登录仍按账号来源处理；保存为手填一次后即可受保护。
- 代理当前只读 Electron 窗口路由，原账号/AI/CLI 安装网络链路保留。全应用代理编辑、企业证书导入、终端选择、npm 安装范围切换没有既有可验证契约，界面提供实际可用状态及对应处理入口。
- 隐私开关只保存本机偏好，当前没有自动崩溃上传或匿名统计收集服务。日志仍走原主进程的脱敏本机记录。
- 安装、低余额、异步任务通知由真实完成/阈值事件触发；原新版本系统通知继续遵守已有总开关。系统没有展示通知时不宣称“已经显示”。
- 设置、账号、Key、会话的原路径与格式继续使用，没有执行一次性的数据库迁移。完整迁移/一键回滚向导尚未接入，不能用保留旧文件冒充完成。
- Win/Mac 截图中的 Mac 是 Chromium 平台样式模拟，不是 Mac 真机证据；Linux 未作为本轮原生验收通过。
- golden 审阅与全部原型新增能力验收尚未结束，因此不能宣称“与原型完全一致”或产品发布就绪。

## 本地 DoD 记录（ui-spec/23 §3）

- [x] 当前原型可运行，原型与实现截图有对照入口。
- [x] 本地接入、范围与差异说明已更新。
- [x] 组件/Token、注册表、品牌来源与旧 UI 导入边界有检查。
- [x] 暗/亮与 Win/Mac 样式矩阵已生成。
- [x] 默认、加载、空、失败交互有本地 mock 覆盖。
- [x] 关键弹层、表单、Tab、菜单、聊天快捷键与 dirty 行为有浏览器检查。
- [ ] 所有界面逐项人工审阅及文案最终核对。
- [ ] 全量测试无未决失败、全部原生验收完成。
- [ ] golden 截图经用户审阅批准。
- [x] 用户明确允许创建 PR 并合并。

本轮下一步是完成源码 PR 与 `main` 合并。Mac 原生验证、Linux 原生验收和超出现有服务契约的能力仍需在后续版本单独处理。

本轮开发预览使用 `node scripts/start-renderer-v2-dev.mjs` 在本地隔离验证，没有读写用户原 profile，也没有执行真实安装或付费生成。浏览器测试与静态原型能力仍需按前述限制理解。
