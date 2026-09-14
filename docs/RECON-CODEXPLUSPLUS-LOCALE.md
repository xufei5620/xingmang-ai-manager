# Codex++ 汉化机制核对

研究对象：用户提供的 `E:/ai项目/源码/CodexPlusPlus-main`，Cargo workspace 版本 `1.3.0`；源码指向 `BigPizzaV3/CodexPlusPlus`。本次只读分析，未启动该项目、安装依赖或复制其实现到产品。该仓库声明 `AGPL-3.0-only`；下文记录机制与行为，不作为代码移植授权。

## 强制中文界面

入口：`apps/codex-plus-manager/src/App.tsx:4815` → `codexAppForceChineseLocale` → `crates/codex-plus-core/src/settings.rs:420`，默认开启。`assets.rs:427` 将该设置注入 `window.__CODEX_PLUS_FORCE_CHINESE_LOCALE__`。

实际实现在 `assets/inject/renderer-inject.js:99`：

1. 只对 Codex 顶层页面执行：检查 `electronBridge`、顶层 window 和 `app://-/`，辅助嵌入页面排除在外（文件第 5 行）。
2. 通过 Codex 自有 `electronBridge.sendMessageFromView` 调用 `vscode://codex/get-setting` / `set-setting`，同步 `localeOverride` 为 `zh-CN`（148、206 行）。这不是向管理器自己的 localStorage 写语言。
3. 首次接管时记录旧值；关闭功能时，仅在当前仍等于自己应用的值时还原，用户后来主动改过则不覆盖（108、219、227 行）。
4. 设置实际发生变化后重载页面，sessionStorage 标记限制重复重载（189、222 行）。
5. 覆盖 `navigator.language/languages`，并包装 Statsig `getDynamicConfig("72216192")`，使 `enable_i18n=true`、`locale_source="SYSTEM"`（261、296 行）。语言文本来自 Codex 已有中文资源。
6. 用属性 setter 捕获稍后发布的 `__STATSIG__`、`firstInstance`、`instance`，再以 50ms 间隔观察 5 秒（313、338、367 行）。

与星芒的 Statsig 开关方案原理相同。Codex++ 主要额外同步官方内存设置；星芒的本地修复还兼容 `getLayer`、多个 Statsig 入口，并验证应用实际读取语言开关。

## 注入连接生命周期

- `cdp.rs:255` 优先选择 `app://-/index.html` 对应的主 page，排除桌宠和快速聊天辅助界面，不默认把 webview 当作主界面。
- `bridge.rs:253` 在同一个 CDP 会话注册 `Page.addScriptToEvaluateOnNewDocument` 并执行当前文档脚本。
- `bridge.rs:322` 将会话留在后台消息循环中；没有在完成第一次注入后立即断开。
- `launcher.rs:941` 每 5 秒检查浏览器身份和 bridge 状态。连续两次确定不健康才重新注入，浏览器身份变更直接触发；探测超时当作未知，不用它触发反复注入（2552 行起）。

这是本次故障最值得采用的机制：0.2.2 会在注入后立即断开会话，旧脚本稍后重载时新文档钩子已失效。已使用旧版脚本在隔离的真实 Chromium 复现补丁由存在变为不存在，与客户报告的 `hasBridge=true / hasStatsig=true / hasPatch=false` 状态一致；这证明旧实现有该缺陷，但不代表排除了客户现场所有其他原因。

星芒当前本地修复把连接保持到重载后验证结束，并增加同 target 文档变化与补丁消失时的恢复；验证成功后仍会断开，因此持续覆盖后续用户刷新/窗口重建还需要独立的生命周期设计，不能声称已拥有 Codex++ 的长期 watchdog。

## 原生菜单汉化

入口：`App.tsx:4817` → `codexAppNativeMenuLocalization`，默认开启。实现独立于网页中文开关：

| 环节 | 机制 |
| --- | --- |
| 启动参数 | `launcher.rs:2445` 增加 `--inspect=127.0.0.1:<port>`，这是 Electron 主进程的 Node inspector。渲染进程仍使用自己的 `--remote-debugging-port`。 |
| 端口 | `launcher.rs:526` 请求渲染调试端口加 100，再选择可用回环端口。 |
| 调用 | Windows 包激活、普通可执行文件及 macOS 启动后异步调用菜单本地化。 |
| 目标 | `native_menu.rs:165` 查询 inspector `/json`，优先 `type=node`。 |
| 修改 | `native_menu.rs:122` 从主进程取得 Electron `Menu`，递归修改 `item.label` / `submenu.items`。 |
| 保持 | `native_menu.rs:145` 包装 `Menu.setApplicationMenu`，未来菜单重建时继续翻译；当前菜单通过 `getApplicationMenu` 立即处理并重新设置。 |
| 词条 | 81 条内置英文到中文映射，不是在线翻译，也不是读取 Codex 官方菜单翻译文件。 |
| 重试 | 最多 20 次，间隔 500ms；每次网络/命令还有独立超时，所以不是严格 10 秒总时限。 |
| 恢复 | 没有菜单回滚 API；重启进程后内存修改消失，关闭开关影响下次启动。安装包不修改。 |

还有另一层 DOM 菜单补全：`renderer-inject.js:427` 的 38 条字典，由 7779 行起的逻辑限定菜单/对话框/命令面板等范围，排除输入框和聊天内容，并通过 MutationObserver 跟踪新增菜单。它与原生菜单并非同一层。

## 实现限制与后续取舍

- 该下载快照的 `FeatureToggle`（App.tsx:9240）只是设置控件；截图中的“正常”和“原生菜单栏位置”不与当前代码完全一致。菜单栏位置字段仍在设置中，但未找到当前实际功能消费，不应据截图推断。
- 强制中文的官方设置同步错误被吞（renderer-inject.js:241），未校验最终中文资源或文本是否成功显示。
- 菜单脚本在找不到 Electron Menu 时返回 `skipped`，Rust 只检查异常，仍记录 installed；移植时必须校验实际结果。
- 菜单翻译只有精确词条匹配，没有覆盖所有版本的 label 变化，也不保证处理仅走 `Menu.popup()` 的独立上下文菜单。
- 若在星芒加入主进程菜单本地化，应分别报告界面语言和菜单结果，严格绑定自己启动的 Codex PID/端口，验证菜单可用与标签变更，保留回调、role、快捷键和 checked/enabled 状态。
- “快速启动”是另一功能，会改变 Statsig 域名解析或初始化超时，不属于汉化修复，不应随汉化一起启用。

建议先完善主页面长期注入生命周期与语言设置回读，再单独设计原生菜单本地化。当前远程证据显示的是主页面补丁缺失；增加菜单翻译本身不能修复这一点。

## 2026-09-13：知乎文章的独立副本方案

来源：[《用 Codex 给 Codex 打中文补丁，这事真成了！》](https://zhuanlan.zhihu.com/p/2054635567762166145)，页面标注发布于 2026-06-28。已查看正文及两张技术截图，具体流程位于图片中，正文抽取会遗漏。

- 截图方案：将官方 Codex 的 `app` 目录复制到 `%LOCALAPPDATA%\OpenAI\CodexZh\app`，在副本 `app.asar` 中将 `enable_i18n` 默认值从 false 改为 true；建立 `Codex Zh` 快捷方式，启动附带中文参数和独立用户数据目录。保留 WindowsApps 官方安装，不重签原 MSIX。
- 相较本仓 CDP 运行时注入，静态补丁随副本保留，能够避开调试会话断开后新文档失去注入的问题；这是可评估的兼容启动路线，尚未移植或验证当前版本。
- 截图只说明修改默认值，没有公开补丁脚本及精确替换规则。若实际只修改 `get("enable_i18n", false)` 的 fallback，远端显式 false 仍可覆盖，不能据此断言彻底强制中文或不依赖 Statsig 初始化。
- 另一截图提到 `user.custom.workspace_type: Invalid input` 和 `reason=statsig-disabled`；这是作者引用的初始化错误线索，不能等同网络不通，也不是本次客户机器已经确认的日志。
- 集成前需要验证当前包的 ASAR 完整性/Store 身份依赖、官方登录、原生菜单与版本更新后的重新补丁。独立 `userData` 会分离部分界面状态和缓存，但默认 `CODEX_HOME` 可能仍共享，不可称完全隔离的账号/历史。
- 本次仅研究并记录，未复制或修改用户 Codex 安装，也未改变启动方式。
