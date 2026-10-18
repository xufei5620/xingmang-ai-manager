# 模块地图

> 从 `AGENTS.md` 第 3 节搬出，目的：让每个会话的固定上下文只装「改代码前必须知道的事」，模块清单按需再读。
> 2026-10-17 按子系统重写（#1072）：本页是总述和索引，每个模块一句话的清单分在 `docs/module-map/` 下的分册里，找文件时只读相关的那一册。
> **一律以代码为准。** 这里不写行数、文件数和行号，它们会过期；要看大小用 `wc -l`。

## 分册

| 分册 | 管什么 |
|---|---|
| [`module-map/main-account-route.md`](./module-map/main-account-route.md) | 主进程：两个账号站与线路、账号后端对接、双账号域与凭据落盘、密钥签发、计费充值、服务状态文件、星芒技能 |
| [`module-map/main-runtime.md`](./module-map/main-runtime.md) | 主进程：生命周期与窗口、启动失败与崩溃、诊断与日志、Windows 提权与可信路径、游戏加速、网络与代理、托盘、更新与发布、设置 |
| [`module-map/main-core-canvas.md`](./module-map/main-core-canvas.md) | 主进程：IPC 边界、命令执行、本地文件与有界读写、首页扫描、配置与备份、会话、扩展、无限画布与 AI 工作区，以及 `electron/platform/` 平台层 |
| [`module-map/main-cli-clients.md`](./module-map/main-cli-clients.md) | 主进程：CLI 安装与运行环境、卸载、Grok、Codex 与 Codex 桌面端、外部桌面客户端（WorkBuddy / Claude Desktop / OpenCode）、macOS 与 Linux 平台模块 |
| [`module-map/renderer-v2.md`](./module-map/renderer-v2.md) | 当前界面 `src/renderer-v2/`：入口与外壳、各页面、`features/`、`registry/`、`ui/`、样式与浏览器回归 |
| [`module-map/legacy-renderer.md`](./module-map/legacy-renderer.md) | 已冻结的 legacy 回滚界面（`src/` 下除 renderer-v2 以外），存量地图 |

## 总述：先知道这几件事

**进程入口不是 `main.ts`。** `package.json` 的 `main` 指向 `dist-electron/platform/entry.js`，所以入口是 `electron/platform/entry.ts`，它按顺序分流：Linux 上以 root 运行就拒绝（`linux-launch-guard.ts`）→ 卸载清理模式（`uninstall-cleanup-entry.ts`）→ 加速辅助进程模式（`acceleration-worker-entry.ts`）→ 都不是才进 `platform/desktop-entry.ts`，装好 renderer-v2 的平台层后 `require('../main')`。`main.ts` 是装配中心：建窗口、注册协议、把各个服务接起来。

**跨进程通道有三套，各自一组「契约 + preload + 注册」**（AGENTS.md T1、I4、I7）：

| 哪一套 | 契约（真相源） | preload（有意重复的字面量通道表） | 注册与校验 | 渲染层拿到的 |
|---|---|---|---|---|
| 主窗口业务 | `ipc-contract.ts` | `preload.ts` | `ipc.ts`，经 `registerTrustedHandler` | `window.xingmang` |
| 主窗口系统设置与通知（只在新界面安装） | `platform/contract.ts` | `platform/preload.ts` | `platform/ipc.ts`，`assertPlatformOwner` 只放行主窗口主框架 | `window.xingmangPlatform` |
| 画布窗口 | `canvas-contract.ts` | `canvas-preload.ts` | `canvas-window.ts`，`assertTrustedCanvasSender` 只放行画布窗口 | `window.xingmangCanvasHost` |

**两个账号站，每站两条线路**（详见 `main-account-route.md` 开头的对照表）：星芒账号 `solov`（`xm.solov.cc`，new-api，`new-api-client.ts`）和历史账号 `solov-api`（`api.solov.cc`，sub2api，`sub2api-*.ts`），由 `realm-account*.ts` 隔成两个账号域。线路1 是 CF 入口（设置值 `primary`），线路2 是洛杉矶直连（`direct`）。线路分两套：管理工具自己的请求走「应用线路」（`relay-route-controller.ts` + `relay-line-fetch.ts`，两个站都有）；写进 AI 工具配置的是「工具线路」（`tool-route-*.ts`，只有星芒账号有）。站点和线路地址只能来自 `relay-sites.ts`。

**对外出网的模块都要守 I10**（超时、体积上限、重定向策略、URL 校验）：账号后端是 `new-api-client.ts`（xm 站，I10 的参考实现）和 `sub2api-account-client.ts`（历史账号站），外面包一层 `relay-line-fetch.ts` 换线路；另有 `service-status.ts`（更新目录上的服务状态文件）、`route-status-file.ts`（服务端线路状态）、`official-account-usage.ts`（ChatGPT 官方限额）、更新器那条链，以及各安装渠道的下载。

**凭据落盘**：多账号库是 `realm-accounts-v2.dat`（`realm-account-vault-file.ts`）；老的 `saved-accounts.dat`、`account-session.dat` 只读不写，留给迁移。所有用 `safeStorage` 的文件（账号库、记住密码、托管 CLI Key、对话 Key）都经 `safe-storage-backend.ts`，它决定 Linux 没有密钥环时只存内存。

**渲染层与主进程的边界**：renderer-v2 可以直接值导入一批 `electron/*` 模块，但只能是 `scripts/verify-renderer-boundary.test.cjs` 里 `valueImportable` 名单上的零 Node 依赖模块（AGENTS.md I6）。legacy 树只经 `src/types.ts` 拿类型和 `ipc-contract.ts` 的少数值导出。

**几条跨多个文件的链路**：

- 星芒自身更新：`update-feed-route.ts` 选源 → `update-request-guard.ts` 管请求 → `update-package-digest.ts`（SHA-512）→ Windows 上 `update-signature.ts`（Authenticode）或无签名通道的 `update-package-signature.ts`（Ed25519）→ `auto-update-install.ts` 决定何时装 → `installed-release.ts` 下次启动说「已更新」，由 `main.ts` 接进 `updater.ts`。
- 游戏加速：`acceleration-service.ts`（主进程门面）→ `acceleration-development-host.ts`（拉起辅助进程；文件名里的 development 是历史名字，正式包也走它）→ 辅助进程 `acceleration-development-worker.ts` → `acceleration-development-backend.ts` + `acceleration-mihomo-runtime.ts` + `platform/windows-system-proxy.ts` / `platform/macos-system-proxy.ts`。只在 Windows 和 macOS 上有。
- AI 对话与生成：画布或聊天的请求 → `canvas-request-parser.ts` 或 `ipc.ts` 校验 → `ai-chat-service.ts` / `ai-image-service.ts` / `ai-video-service.ts` → 密钥只在主进程由 `chat-credential-coordinator.ts` 给出（I15）→ 产物进 `ai-asset-store.ts` 等 → 经 `xingmang-asset://` 显示。
- 画布运行：`canvas-window.ts` → `canvas-run-service.ts` → `canvas-run-engine.ts` → `canvas-node-executors.ts` → 上面的 AI 服务，记录落在 `canvas-run-store.ts`。
- 登录后写工具：`account-cli-provisioner.ts` 按分组签密钥 → `config-files.ts` 两阶段写入（I9）→ `xingmang-ai-skill.ts` 写星芒技能配置。

**容易混的几对**：

- `installation-queue.ts` 是 I11 要求的安装、卸载、启动队列；`bounded-operation-queue.ts` 是图片生成和扫描探测用的通用并发队列，不能拿来替代前者。
- 服务端的两份状态文件：更新目录（R2）上的 `service-status.json`（`service-status.ts` 读）和站点上的 `/xm-route-status.json`（`route-status-file.ts` 读）。本地的四份：`relay-route-lines.json`（应用线路）、`tool-route-state.json`（工具线路）、`release-guard.json`（撤回名单与放量）、`cli-model-hints.json`（型号表）。
- `platform-capabilities.ts` 是判断「当前平台支持什么」的单一入口，渲染层的平台能力来自 `ipc.ts` 的 `platform:get-capabilities`。

## 自查：有没有模块没进地图

加了新模块就在对应分册补一行。下面这条命令列出还没出现在任何分册里的主进程模块和 renderer-v2 文件（不含测试）：

```bash
for f in $(git ls-files 'electron/*.ts' 'electron/platform/*.ts' 'src/renderer-v2/**' | grep -v '\.test\.' | grep -v '/README.md$'); do
  case "$f" in electron/platform/*) key="platform/${f#electron/platform/}" ;; electron/*) key="${f#electron/}" ;; *) key="${f#src/renderer-v2/}" ;; esac
  grep -qF "\`$key\`" docs/module-map/*.md || echo "$f"
done
```
