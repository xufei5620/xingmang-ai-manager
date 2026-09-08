# 项目复查报告（2026-09-08，v3.1.1 合并后）

复查对象：`main` 顶端 `ec26b33`（PR #117，0.1.32）。这次合并加上前一天的 #116 一共改动 327 个文件、约 4.6 万行：`src/renderer-v2/` 从零新增（138 个文件）、`electron/platform/` 新增 23 个文件、主进程新增 saved-accounts / window-lifecycle / window-preferences / window-close-query / external-deep-links、React 升 19、`vitest.config.ts` 出现、package `main` 改为 `dist-electron/platform/entry.js`。

复查方法：在 Linux 云端容器跑全部门槛；按 CLAUDE.md 第 4、5 节逐条对新代码做静态核对；对拿不准的 Electron 行为写最小脚本在 xvfb 下复现。**没有对生产 `xm.solov.cc` 发任何请求。**

## 1. 门槛结果

| 门槛 | 结果 |
|---|---|
| `npm run typecheck`（四段） | 通过 |
| vitest `electron src`（含 renderer-v2 project） | 263 文件：2973 通过 / 192 平台门控跳过 / 0 失败 |
| `npm run test:canvas` | 73 文件 498 通过 |
| `npm run test:node`（scripts + e2e + test:ui） | scripts 99 通过 1 跳过；e2e 20 通过；test:ui 62 通过（含 Windows 侧记录为既有失败的 `shell-navigation-interactions`，Linux 下通过） |
| `npm run test:v2:browser` | 修复前 34/86（52 个是找不到 Chromium 的环境失败）；修复启动缝后 86/86 |
| `npm run compile` | 通过，`dist/renderer-v2.flag` 已产出，v2 bundle 不含旧 `src/` |
| `npm run audit:production` | 0 漏洞 |
| 测试后工作树 | 干净，无 `\tmp\xingmang-managed-cli-*` 泄漏 |

Playwright 套件需要 `XINGMANG_E2E_CHROMIUM=/opt/pw-browsers/chromium`（容器预装 1194，`@playwright/test` 1.62 期望 1234）。CI 先 `playwright install chromium`，不受影响。

## 2. 发现（按严重度）

### 2.1 中：平台 preload 会注入画布窗口（I15 字面违反，暂无能力泄漏）

`electron/platform/install-system-api.ts` 在主窗口的 session 上调用 `session.registerPreloadScript({ type: 'frame' })`。主窗口用的是默认 session，画布窗口（`canvas-window.ts`）没有设 `partition`，也用默认 session。Electron 43.6.0 下用两窗口最小脚本复现：两个窗口的主帧都拿到了 `contextBridge` 暴露的对象。因此画布主帧里存在 `window.xingmangPlatform`，含 9 个 invoke 方法与 1 个订阅。

缓解：`assertPlatformOwner` 要求 `event.sender === owner` 且主帧 URL 可信，画布发的 9 个调用全部会被拒绝；推送只 `owner.send`。所以今天没有能力泄漏，但违反了"画布能力只减不增"的规则，也让"画布拿不到主窗口 IPC"这句不再字面成立。支付窗口有随机 `partition`，不受影响。

修法二选一，都很小：画布窗口 `webPreferences.partition` 改为独立值；或平台 preload 只在 `location.href` 属于主窗口 URL 时 `exposeInMainWorld`。

### 2.2 中：主窗口缩放有两套算法同时生效，且常量分叉

- `electron/window-preferences.ts` `calculateUiZoom`：下限 **0.8**，`main.ts` 的 `applyPreferences` 用它，挂在 `resize` / `did-finish-load` / 设置保存回调。
- `electron/platform/zoom.ts` `calculatePlatformZoom`：下限 **0.7**，`platform/renderer-v2.ts` 用它，同样挂在 `resize` / `did-finish-load`，另加 500ms 轮询 `settings.json`。

两套算法除下限外完全相同。内容宽 896–1023 DIP 时两者给出不同值：960 宽下主进程算 0.8，平台层算 0.75；后注册的平台层最后写入所以平时看到 0.75（`renderer-v2-native.mjs` 记录的也是 0.75），但设置保存后先由主进程写 0.8，最多 500ms 后再被平台层改回 0.75，标题栏 overlay 高度也随之跳动。`window-preferences.test.ts` 钉的是 0.8，`platform/facade.test.ts` 钉的是 0.7，`ui-spec/03-layout-window.md §1` 写的是 0.7。

建议：只保留一份。按规范应取 0.7，把 `window-preferences.ts` 的 `UI_MIN_ZOOM` 改成 0.7 并让 `main.ts` 直接用 `platform/zoom.ts`，删掉 `renderer-v2.ts` 里的第二个 applier 与文件轮询（F11 全屏可以留）。

### 2.3 中：平台 IPC 绕过了 `registerTrustedHandler`（I4 第二个例外，未登记）

`electron/platform/ipc.ts` 直接 `ipcMain.handle` 9 个 `xingmang-platform:*` 通道。自带的 `assertPlatformOwner` 校验强度足够（sender 必须是主窗口、必须是主帧、URL 必须可信、参数个数与类型逐个校验），单测覆盖了其他窗口、子帧、外部导航等拒绝路径。缺的是 `registerTrustedHandler` 的结构化日志与统一 dispose，且这些通道不在 `ipc-contract.ts` 的 `ipcInvokeChannels` 表里，T1 的顺序测试与 preload 契约测试都管不到它们。

建议：要么把 9 个通道并回 `ipcInvokeChannels` + `registerTrustedHandler`（同时把 `platform/preload.ts` 合进 `preload.ts`），要么在 CLAUDE.md I4 正式登记为第二个例外并说明为什么（已先按"现状"写进 I4）。两者都可，但不要再出现第三条注册路径。

### 2.4 低：主题与系统通知各有两份实现

- 主题：`settings.json.theme`（旧 `window:set-theme` 链）与 `platform-settings.json.themePreference`（平台层）都在持久化。renderer-v2 的设置页改主题走平台层，`bindPlatformAppearance` 再回写 `setWindowTheme`，所以两份目前是同步的；但旧界面或任何只改 `settings.json` 的路径都会让 `platform-settings.json` 留下陈旧值，下次 v2 启动时以平台层为准。
- 通知：`desktop-notifications.ts`（更新类，主进程原有）与 `platform/notifications.ts`（install / balance / task 三类）并存，两者共用同一个 `desktopNotifications` 总开关，但去重、图标、点击行为各写一份。

这是 CLAUDE.md §0"平台新增只在 `electron/platform/`"约束的直接后果，不是失误，但下一轮应该收口成一份。

### 2.5 低：renderer-v2 三个浏览器检查脚本缺 Chromium 路径缝（已修）

`features/auth/browser-check.mjs`、`features/chat/browser-check.mjs`、`testing/app-check.mjs` 直接 `chromium.launch()`，其他 17 个 Playwright 启动点都读 `XINGMANG_E2E_CHROMIUM`。这就是本次 52 个失败的全部原因。本分支已补齐，三个文件各一行，复跑 86/86。

### 2.6 低：代码风格漂移

`src/renderer-v2/ui/*.tsx`（floating / brand / core / modal / shared / fields / feedback 等）约 280 行以分号结尾，10 个顶层箭头函数导出；`electron/platform/` 与其余 renderer-v2 文件都符合 §6 约定。不建议专门刷格式（§8），但新代码不要延续。

### 2.7 低：文档漂移（已校准）

- CLAUDE.md：§2 的模块/测试/IPC 计数、命令注释（typecheck 已是四段、`npm test` 已不是十几秒）、§3 模块地图（缺 `electron/platform/`、窗口生命周期、saved-accounts、整个 `src/renderer-v2/`）、行号（main.ts / ipc-contract / preload / system-service 分界 / App.tsx / styles.css）、T7（"仓库没有 vitest.config.ts"已不成立）、I4 / I15 的画布通道数（43 → 49）与新例外、§0 的验收期禁令状态。本分支已按实测数字改齐。
- HANDOFF.md 止于 2026-08-10，描述的分支与批次已成历史；顶部加了时效横幅指向当前文档。

### 2.8 信息：公告富文本是新的输入面，设计正确

`src/renderer-v2/features/shell/Announcement.tsx`（873 行）对 `/api/notice` 返回的 HTML 做自研净化：白名单标签/属性、CSS 里禁 `url()`/表达式/外链、SVG 只允许静态子集，再放进 `srcdoc` iframe，`sandbox="allow-same-origin"` 但**不给** `allow-scripts`，文档头注入 `default-src 'none'` 的 meta CSP，主窗口另有 `will-frame-navigate` 守卫只放行 `about:blank` / `about:srcdoc`。这个组合是对的（同源无脚本的 iframe 无法反向触及父页）。主进程侧公告端点单独放宽到 4 MB，其他端点仍 512 KB，宽松信封解析只限该端点。`new-api-notice-real-shape.test.ts` 用生产约 2.4 MB 真实形状回归。建议保留这份 corpus 并在公告样式再变时补样本，自研 sanitizer 的风险在于回归而非首版。

### 2.9 信息：`ui-spec/work/` 入库

53 个原型工作文件（含 `build-prototype.py` 与多份 `*-check.cjs`）随 #117 入库，`e2e/prototype-reference-capture.cjs` 与 `renderer-v2-component-surface-check.mjs` 引用其 `reference-harness.cjs`。Python 不是项目依赖，仅原型重建时用。可以接受，但要知道它在。

## 3. 核对过、没有问题的点

- I1：全仓 0 处 `shell:true` / `execSync`；新代码 0 处 `as any` / `@ts-ignore` / `eslint-disable`。
- I3：renderer-v2 无任何 Key / token 落 localStorage（只存聊天记录、引导进度、头像 PNG、手填来源标记、界面偏好，均有大小与格式校验）；`saved-accounts.ts` 的 cookie 只在主进程，`account:list-saved` 只回摘要，`account:switch-saved` 只收 64 位十六进制 id。
- I5：新增 11 个主窗口通道的入参都有显式校验；`external-deep-links.ts` 只认 `xingmang://pay|invite` 两种形状，其余 `invalid`，只入队不导航，打包态才注册协议。
- I10：主进程改用 Electron `net.fetch`（走系统/会话代理），`new-api-client` 与 `ai-chat-service` 都加了 `credentials:'omit'`，`redirect:'manual'` 与响应 origin 校验未动。
- I12：支付窗口独立随机 `partition`；主窗口新增 `will-frame-navigate` 守卫。
- T1：`ipc.test.ts:363` 的通道顺序断言仍在，140 个 `registerTrustedHandler` 与契约表一致。
- T13：`scripts/verify-canvas-renderer-boundary.test.cjs` 仍在 `npm test` 里并通过；renderer-v2 也没有直接出网代码。
- 依赖：生产依赖 0 漏洞；旧渲染的 React 18 隔离在 `tooling/legacy-renderer/` workspace，Vite 与 vitest 都按模式别名。

## 4. 建议的下一步（需要产品负责人拍板的三项）

1. 缩放下限取 0.7 还是 0.8（2.2），定了就删掉另一份算法。
2. `xingmang-platform:*` 是并回 `registerTrustedHandler` 还是登记为 I4 例外（2.3）。
3. 画布窗口是否改独立 `partition`（2.1，推荐改，一行）。

其余（2.4 收口双实现、2.6 风格）可以随后续界面工作顺带处理。

## 5. 本分支改动

- `src/renderer-v2/features/auth/browser-check.mjs`、`features/chat/browser-check.mjs`、`testing/app-check.mjs`：补 `executablePath: process.env.XINGMANG_E2E_CHROMIUM || undefined`。
- `CLAUDE.md`：按第 2.7 节校准；只改事实与现状描述，不改规则。
- `HANDOFF.md`：顶部时效横幅。
- 本文件。
