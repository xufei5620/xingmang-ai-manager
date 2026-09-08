# V2 业务页面本地接入记录

本记录覆盖从空目录重建的业务页面，不表示整个应用已完成最终验收；未创建、推送或合并 PR。

## 接入入口

- `src/renderer-v2/pages-business.tsx`：`BusinessPage` 页面分发。
- `src/renderer-v2/pages-account.tsx`：原型九页签；我的账号按左基本资料、右余额/保存账号/设备排版。
- `src/renderer-v2/pages-management.tsx`：多工具记录、MCP、技能、插件、市场、备份及详情抽屉。
- `src/renderer-v2/pages-maintenance.tsx`：检查、反馈、更新、安装卸载、八组设置、教程。
- `src/renderer-v2/SavedAccounts.tsx`：可供账号页与外壳共用的保存账号列表。
- `src/renderer-v2/AccountFilters.tsx`：调用明细和异步任务的筛选表单。
- `src/renderer-v2/business-common.tsx`：加载回包隔离、操作错误、活动任务登记和分页。

页面仅引用新版渲染层与已存在的 IPC 契约。没有复制或导入旧 `src/` 的页面、组件或样式，没有改动主进程业务、安装链路、账号服务、画布引擎或发布配置。

## 业务边界

- 账号及各页签数据来自原 `XingmangApi`；同账号的已访问页签保留表单草稿。父级必须继续以账号来源和用户编号隔离页面实例。
- 保存账号以 `origin + userId` 识别当前账号。默认不重写工具密钥。展开「同步到工具（可选）」可逐个勾选；只有已安装、检测成功、持有星芒密钥且未选择官方来源的 CLI 才可勾选。切换成功后重新读取配置、状态及当前账号，再同步仍符合条件的工具。部分失败清单按账号保留，未勾选及来源变化的工具不修改。
- 普通登录、注册后登录及已登录会话恢复会同步账号托管 Key；已安装且缺少星芒配置的工具自动写入并回读 Key、Relay 与模型。登录时已有星芒来源会刷新为当前账号的托管 Key；恢复启动时已验证的配置不会重复写。官方和第三方来源不覆盖。保存账号切换继续遵守上一条的显式勾选范围。
- 新版“自己填写密钥”在本机按 relay origin + Provider 记录来源，登录、恢复和重试均保留；Codex CLI/桌面端共享同一标记。账号 Key、自动托管或官方来源保存成功后清除标记。旧版既有同域手填配置无法从安全摘要中与托管 Key 区分，首次重新保存为手填后才具备该保护。
- `paymentReturn` 只触发订单查询；重复回跳同一订单仍刷新，不本地确认到账、不重复创建支付。
- 密钥写入明确使用 `merge`，保留其他配置。复制、显示、撤销、编辑与配置各自调用原有接口。
- MCP、技能、插件变更遵守原主进程返回的 `operations`、scope 和管理能力。内置技能只读。
- 会话详情使用真实多工具契约；Codex 归档/恢复传递原 `nativeId`，并先检查 capability。
- 备份恢复先预览及确认，展示白名单文件，保留恢复前快照。
- 反馈预览、复制、导出使用同一个报告快照编号，过期或失败保留预览供处理。
- 设置按字段串行保存，失败保持持久化值；后续保存继续执行。未成功写入不显示“已保存”。
- `pendingBusinessOperations()` 可供外壳关闭保护读取。组件离开后尚未完成的操作仍保留到 Promise 结束。
- 卸载结果仅在 `uninstalled`/`not-installed` 时报告完成；委托到系统窗口和需要手动操作均要求重新检查。

## 新增独立系统能力

`electron/platform/contract.ts` 提供 `window.xingmangPlatform`，通过 Electron 43 `session.registerPreloadScript({ type: 'frame' })` 注册独立 sandbox preload。没有改动原主进程 IPC 契约、原 preload 或 app-settings schema。请求同时校验主窗口 WebContents 身份、mainFrame 身份、当前 URL 与原有 URL 白名单。

- `getState`、`setThemePreference`、`setHighContrast`、`setStartup`：主题跟随系统、高对比、Windows/macOS 正式应用启动项；开发模式不读写开机启动项，macOS 待系统审批与已启用状态分开显示。
- 偏好单独保存到 `platform-settings.json`，原文件无效或版本不识别时保留原文件并报错，不重置为假成功。
- `getProxyStatus`：只读查询固定账号域的 Electron 窗口路由，不接受任意 URL。不会改机器代理；账号、AI、安装器的 Node/CLI 网络路径保持原样，因此不提供会误导用户的全应用代理切换开关。
- `setNotificationPreference` 保存 install/balance/task 三类细分偏好，`testNotification` 发送固定测试内容；`notifyActivity(kind,eventKey)` 只接受有限类别和事件编号，固定内容、去重，不接受任意通知文本或外链。所有新通知均读取原 `desktopNotifications` 总开关。原主程序更新通知仍由原控制器和总开关管理，未引入重复的新版本通知控制器。
- `setPrivacyPreference` 保存 `crashReports`/`anonymousUsage` 本机偏好。当前没有自动上传或匿名数据收集服务。开关不会发请求、不删除服务端数据、不把原有本机错误日志伪装成上传服务。
- 四套皮肤选择用原 `saveSettings({version:2,uiSkin})`，名称及色板来自 `99-skin`；写入失败保持原值。

总入口集成使用 `installPlatformSystemApi(...)`。renderer 总入口用 `bindPlatformAppearance(platform,native,onTheme,onError)` 监听主题与高对比；高对比同步 `data-contrast` 与 `html.hc`。`onError` 是必填回调，不静默吞掉初始化失败。主应用需在实际成功事件后调用 `notifyActivity`；接口可用和设置通过不能独自证明每种业务事件都已接通。

## 尚无对应业务能力的范围

服务器头像上传、终端选择、npm 安装范围切换、全应用代理编辑、企业证书导入、完整数据迁移/回滚仍没有经过验证的业务契约，显示实际可用状态及教程/检查/安装页入口。头像选择、方形裁剪和本机保存已由 `LocalAvatar` 实现，按 HTTPS origin + userId 隔离并同步侧栏；弹窗明确本机保存范围。不能把本机头像或其他替代入口称为服务器能力已经实现。隐私上传和统计收集同样未实现；仅保存偏好。

设置迁移与回滚没有复制原型的演示成功。当前读取既有设置和配置路径；工具配置备份与反馈报告导出使用既有接口。

原型与实现的剩余逐项视觉差异、全部旧功能盘点和原生平台验证仍由应用总验收继续核对；这份记录不把截图数量当作全面功能通过证明。

## 已运行的本地验证

- `npx vitest run electron/platform src/renderer-v2/account-switch-sync.test.ts src/renderer-v2/business.test.ts --no-file-parallelism`：36 项通过；原生系统 API 均使用 mock，存储只写临时测试目录。
- `node --test e2e/v2-business.test.mjs`：16 组通过，覆盖真实 DTO 展示、失败回退、native ID、恢复确认、报告快照、更新阶段、支付回跳及草稿保留、选择性密钥同步、平台设置、四皮肤、通知总开关和隐私偏好、账号任务由处理中转为成功的通知去重。
- `node e2e/v2-business-screenshots.mjs`：240 张截图，20 个页面及账号面板 × 暗/亮 × Win/Mac 样式 × 默认/空/失败。包含当前 Shell；检查页面非空、无页面运行错误、横向不溢出。
- 所有浏览器测试与截图仅使用本地 typed mock；不访问生产账号、支付或安装接口。

截图由 `e2e/v2-business-screenshots.mjs` 在本地生成，并在平台设置、选择性密钥同步与本机头像补齐后重新拍摄；PNG、清单和对照索引按产品负责人要求不进入源码 PR。截图中的 macOS 是 Chromium 下的样式分支，不是 macOS 真机证据。设置与教程等没有自然“空态”的页面保持正常内容；不会制造不存在的产品状态。
