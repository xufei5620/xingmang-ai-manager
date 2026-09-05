# 改进计划

本文档记录一次全面代码审查的结论与待办。所有问题均经过代码逐行核实，标注了文件与行号。

审查范围：Electron 主进程安全、自动更新与发布链路、渲染进程正确性、主进程业务逻辑、构建配置与依赖、测试质量，以及两类真实用户反馈的根因排查（"已装 Node.js 检测不到"、"下载环境慢或失败"）。

**执行原则：按"风险递增、收益递减"分批。** 前面的批次解决用户当前正在遭遇的问题且几乎不可能引入回归；后面的批次才涉及安全模型与工程基础设施。

---

## 批次 0：Mac 适配优先（阻塞 Mac 分支的验证）

> **✅ 全部落地（2026-08-10 核实）**：0.1 平台门控——`electron/` 现有约 99 处 `runIf`，覆盖点名的全部 10 个文件；0.2 泄漏根治——`managed-cli.test.ts` 真实 FS 用例全部平台门控，Linux 跑完 `npm test` 工作树干净；0.3 CI——`quality.yml` 现有 windows/macos/linux 三个 test job + audit job（`23a1e87`）。以下为原始分析，留档。

Mac 适配分支会立刻撞上这批问题，不先修则无法区分"新改动坏的"和"本来就坏的"。

### 0.1 给 Windows 专有测试加平台门控

`npm test` 在 macOS/Linux 上有 **17 个用例失败**，涉及 10 个文件：`security` / `system-shell` / `windows-elevation` / `trusted-temp` / `tool-installation` / `command-runner` / `node-runtime` / `codex-extensions` / `provider-extensions` / `managed-cli`。

这些测试断言 Windows 专有行为（硬编码 `C:` 路径、`path.win32` 结果），却没有平台门控。`command-runner.test.ts`、`node-runtime.test.ts` 等已有 `runIf` 用法可参照。

**做法**：用 `it.runIf(process.platform === 'win32')` 门控，而不是改断言去迁就 posix —— 后者会弱化对 Windows 行为的验证。

**验证**：Linux/macOS 上 `npm test` 全绿（Windows 专有用例显示 skipped），Windows 上用例数不减。

### 0.2 根治 `managed-cli.test.ts` 的仓库目录污染

`electron/managed-cli.test.ts:57-65` 以 `platform:'win32'` 调用 `ensureManagedNpmLayout`，但传入 posix 临时路径。实现端 `managed-cli-paths.ts` 用 `path.win32.join` 把 `/tmp/xxx` 变成 `\tmp\xxx` 反斜杠串；在 posix 上 `path.resolve` 把它当单个相对文件名解析到 CWD（仓库根），于是 `mkdir` 出名字带字面反斜杠的目录。`afterEach` 只清理真实 `/tmp` 目录，这些残留从不清理，`.gitignore` 也不覆盖。

实测每次运行泄漏若干个。

**做法**：不能只把断言从 `path.join` 改成 `path.win32.join` —— 那只修了断言，仍会往 CWD 写。需要让该用例在非 Windows 上不执行真实文件系统操作。

**验证**：Linux 上跑完 `npm test` 后 `git status` 应干净。

### 0.3 CI 增加非 Windows 平台的 job

`.github/workflows/quality.yml:12` 的 test job 只 `runs-on: windows-latest`，ubuntu job 只跑 `npm run audit:*`。所以跨平台破坏永远不会在 CI 暴露。而 `MAC_SOURCE_README.md:23-28` 明确要求 macOS 用户执行 `npm ci` / `npm run typecheck` / `npm test` 验证源码包。

**做法**：新增 ubuntu-latest（Mac 版上线后可加 macos-latest）的 job，跑 typecheck + test。

**依赖**：需先完成 0.1、0.2，否则新 job 一加就是红的。

---

## 批次 1：止血（改动都在几行内，风险接近零）

> **✅ 全部落地（2026-08-10 核实）**：1.1 `system-service.ts` 两处扫描已改 `Promise.allSettled`（失败项落 `detectionFailed:true` 占位）；1.2 unknown 区域已镜像优先（`npmInstallRegistries` / `nodeRuntimeDownloadSources`）且区域缓存延至 10 分钟；1.3 Codex 桌面端清单源已镜像优先——**注意函数已迁至 `electron/codex-desktop-service.ts`**，测试钉住顺序；1.4 TOML 解析失败回退 `'OpenAI'`（`config-files.ts` 的 `existingCodexProvider`）；1.5 以等价解法消除——未加 `playwright` 依赖，7 个 e2e 脚本全部改从 `@playwright/test` 导入。以下为原始分析，留档。

共同特点：**要么只改失败路径（原本就是坏的，不可能更坏），要么只加备选源（原有源仍在）。**

### 1.1 扫描容错：`Promise.all` 改 `allSettled`

`electron/system-service.ts:2105` 用 `Promise.all` 并发五个探测（`inspectNode` / `inspectTool('npm')` / `inspectPython` / `inspectCodexDesktop` / `inspectNetworkLocation`），任一抛错整个 `scanSystem` reject。

紧邻其下的 CLI 探测却特意用了 `allSettled` 并注释"单个 CLI 探测异常时降级为未安装，避免拖垮整份系统快照"—— **作者知道风险但只保护了一半。**

`inspectCodexDesktop`（1845 行起）内部还套一层 `Promise.all`，包含四个 PowerShell/网络探测（AppX 枚举、进程列表、包信息、镜像版本），在用户机器上（组策略限制 PowerShell、安全软件拦截、AppX 子系统异常）容易抛错。

**后果链**（这正是用户反馈的"已装 Node.js 但检测不到"）：

```
inspectCodexDesktop 抛错
  → scanSystem 整体 reject
  → scan-coordinator 的 allSettled 吞掉，返回 snapshot: null
  → App.tsx:556-565 兜底到 EmptyStatus
  → 界面：Node/npm/Python/四个 CLI 全部"未安装"，"最后检测 Invalid Date"
```

**做法**：两处改 `allSettled`。第一批失败项先返回与现在完全相同的"未安装"占位对象，下游零改动，行为严格优于现状。区分"失败"与"未安装"留给 2.1（拆两步是为了让这一步风险归零）。

### 1.2 区域探测失败时改为镜像优先

`electron/system-service.ts:126` 用 `https://www.cloudflare.com/cdn-cgi/trace` 探测区域，超时 2.5 秒（962-965 行）。失败则 `region='unknown'`，`npmInstallRegistries('unknown')` 返回 `[官方, 镜像]`（969-973 行），`nodeRuntimeDownloadSources` 同理（`node-runtime.ts:335-341`）。

**问题：国际网络越差的用户越容易探测失败，越会被判给官方源 —— 供需完全反了。** `unknown` 缓存只有 60 秒，每次重试再花 2.5 秒。

**做法**：只改 `unknown` 分支的数组顺序（返回 `[镜像, 官方]`），另两个分支一个字不动。同时延长 `unknown` 缓存至少到 10 分钟。

**代价不对称的论证**：海外用户被误判走 npmmirror 只是慢几秒（有全球 CDN）；国内用户被误判走官方源是彻底装不上。本产品面向国内用户，`unknown` 就该倒向镜像。

### 1.3 Codex 桌面端清单源改为镜像优先

`electron/system-service.ts:428-433` 的 `buildCodexDesktopManifestSources` 返回 `[官方, 镜像]`，而 `buildCodexDesktopPackageSources`（421-425）的包下载已经是纯镜像。两者不一致，调整数组顺序即可。

### 1.4 Codex 配置 reset 在 TOML 解析失败时回退默认 provider 名

`electron/config-files.ts:352-353`，reset 模式的 `createPlans` 第一步就调 `existingCodexProvider(paths[0])` 读现有 `~/.codex/config.toml`；该函数（306-315）在 `TOML.parse` 失败时抛错。而 `createMergePlans:441-442` 无条件先调 `createPlans`，所以 merge 会在更早处抛同一个错。

**后果**：配置文件损坏的用户，merge 和 reset 都是死路，应用内无任何修复途径。放大点：`src/onboarding-flow.ts:67-72` 首次授权固定 `mode:'reset'`，这类用户会在 onboarding 阶段**彻底卡死出不去**。而 UI 文案（`App.tsx:2806-2811`）明确把 reset 定位为"若不能正常使用请用此项重置配置文件"的逃生通道 —— 实现与承诺矛盾。

**做法**：`existingCodexProvider` 解析失败时返回默认 `'OpenAI'`（它在 ENOENT 时本来就返回这个），而不是抛错。对比 grok 的 reset 分支（417-435）完全不读旧文件，改完两边语义一致。

**无数据风险**：`executeFilePlans`（699-708）覆盖前必然创建时间戳 `.bak` 备份。

### 1.5 `playwright` 显式声明进 devDependencies

`e2e/` 下三个 `.mjs` 脚本 `import ... from 'playwright'`，但 `package.json` 只声明了 `@playwright/test`。当前靠 npm 扁平化提升才能跑。改用 pnpm 等严格布局、或上游调整依赖结构，CI 的两个 smoke 步骤与 `release:build` 的冒烟门禁都会中断。

---

## 批次 2：用户体验（需新增字段，但保证向后兼容）

> **状态（2026-08-10 第二次更新）**：2.1 ✅（`detectionFailed?`/`detectionError?` 可选字段 + 渲染层"检测失败，点击重试"三处文案，`317b34f`/`171fd74`）；2.3 ✅ 三条做法全做（解析/下载超时分离 10min/5min、心跳 `setInterval`、开始文案，对账逻辑未被绕过）；**2.4 ✅**（`d8f4209`：`AppSettings.mirrorPolicy` + `effectiveNetworkRegion` 归约 + 设置页三态下拉 + 钉死时跳过区域探测；**刻意不覆盖 Codex 桌面端清单**——其包字节仅镜像可得，清单跟随 official-first 会复活 1.3 修掉的版本错配）；**2.2 收口**（措施1 重启提示 = `d8f4209`；措施2/3 **已拍板不做**——2026-08-10 老板授权按推荐处理：应用内托管安装 Node + 重启提示已覆盖主要工单面，措施2 要扩路径信任面、措施3 边际收益小）；**2.5 暂缓**（按本节自己的优先级论证：1.2 与 2.4 落地后边际收益已不大，不做）；**2.6 维持暂缓**（2026-08-10 按推荐处理：唯一前置仍是"对 agentsmirror 基础设施是否有控制权、能否放 Grok 二进制"的确认，只能由老板答复；确认后按 Codex 桌面端同款模式接入，代码侧无阻塞）。另更正 2.2 原文一处前提：`FNM_MULTISHELL_PATH` 自初始导入起就在 `defaultCommandPaths` 候选表——但它是 shell 会话级变量，GUI 启动的进程继承不到，所以列了也探不到 fnm 装的 Node，结论仍成立。

### 2.1 区分"检测失败"与"确实未安装"

探测失败被渲染成确定的"未安装"结论。`App.tsx:238-268` 的 `EmptyStatus`（`checkedAt` 空串、全部 `installed:false`）在首次扫描失败时被当作真实数据展示：头部显示"最后检测 Invalid Date"，四个 CLI 全显示"未安装"且安装按钮可点，`MaintenancePage.refresh`（298-312）还会**自动勾选全部四个、主按钮变成"批量安装 (4)"**。页面级无任何失败提示。

后果：诱导用户对已装好的工具重复安装 —— 很可能是一部分用户工单的来源。

**做法**：

1. 给 `ToolStatus` 加**可选**字段 `detectionFailed?: boolean`（可再加 `detectionError?: string`，只放给用户看的简短原因，不放堆栈）。语义约定"字段缺省 = 探测成功"，保证所有未更新的消费方行为不变。
2. 快照顶层可加 `degraded?: boolean` / `failedProbes?: string[]`。
3. 界面：失败项显示"检测失败，点击重试"而非"未安装"，禁用该项安装按钮，不自动勾选。
4. `checkedAt` 为空时不渲染 Invalid Date。

**已验证的兼容性前提**：`electron/ipc-contract.ts:98` 是 `export type ToolStatus = MainToolStatus`（直接 re-export 主进程类型），没有独立的运行时 schema 校验，所以新增可选字段不会被 strip 或 reject。

**依赖**：1.1 先完成。

### 2.2 Node.js 检测增强

Node 检测 = `findExecutable('node')` 遍历 `commandEnvironment().PATH`（`command-runner.ts:523-556`）。PATH 来自应用启动时继承的 `process.env.PATH`，用户装完 Node 不重启应用就检测不到（Windows 固有行为：MSI 只改注册表 PATH，已运行进程不刷新）。

`command-runner.ts:402-426` 的 `defaultCommandPaths` 已硬编码一批候选（`Program Files\nodejs`、`ProgramW6432`、`LOCALAPPDATA\Programs\nodejs`、`NVM_SYMLINK`、`VOLTA_HOME`、scoop、chocolatey），但仍漏掉：

- **自定义安装目录**（MSI 允许改路径，如 `D:\dev\nodejs`）
- **fnm**（`FNM_MULTISHELL_PATH` 是 shell 级变量，从 Explorer 启动的 GUI 应用继承不到）

**做法**（按性价比排序）：

1. **检测不到时提示"如果刚安装完 Node.js，请重启本软件"** —— 成本几乎为零，能解决相当比例工单。
2. **加"手动指定 Node.js 路径"入口** —— 比穷举安装位置更可靠，是终极兜底。
3. **从注册表读 `HKLM\SOFTWARE\Node.js\InstallPath`** 补进候选目录。必须走既有的路径信任校验，不能直接信任注册表值。

### 2.3 npm 安装"官方源对账"步骤的假死体验

npm 安装无论区域如何都强制先走两次官方源：

- `system-service.ts:2313-2318` `fetchNpmPackageReleaseMetadata(npmOfficialRegistry, ...)`
- `system-service.ts:2382-2388` `executeNpm(['install','--package-lock-only',...,'--registry=官方'])`

这是**有意的安全设计**：拿官方权威依赖图和 SHA-512 去和镜像内容对账（2436 行日志"国内 npm 镜像完整依赖图与官方 SHA-512 对账通过"），防镜像投毒。

代价：`@anthropic-ai/claude-code` 这类包的完整依赖图解析要向 registry.npmjs.org 发起数百次元数据请求，是国内用户整个安装里最慢的部分，**镜像完全帮不上忙**。单次 npm 超时 5 分钟（2355 行）。界面上只有一句静态文案，然后没动静，用户以为卡死。

> **明确不要做**：不要为了提速而绕过官方源对账 —— 那会削弱防镜像投毒的核心设计。

**做法（只改体验）**：

1. 给这一步单独设更长的超时（与后续下载步骤分开计时）。
2. 提供持续的心跳/进度输出。
3. 文案改为："正在从官方源校验完整性，国内网络下此步骤较慢（不影响后续下载速度），请耐心等待"。

### 2.4 设置页增加「镜像策略」三态开关

自动判断再聪明也会失手，给用户一条自救的路。出问题时可以直接告诉用户"设置里切成强制国内镜像"。**这条的实用价值可能超过所有自动探测优化。**

- 三态：`mirror-first` / `auto`（默认，保持现有行为）/ `official-first`
- 配置存 `electron/app-settings.ts`（`SettingsPage` 已有 `settingsEqual` / `reconcileSettingsDraft` 纯函数模式可复用）
- 需覆盖所有源选择点：`npmInstallRegistries`、`nodeRuntimeDownloadSources`、`buildCodexDesktopManifestSources`，以及 2.6 的 Grok 镜像
- 设置为非 auto 时跳过区域探测，省掉 2.5 秒

### 2.5 （可选升级）用并发赛跑替代 Cloudflare 区域探测

彻底去掉对 `www.cloudflare.com` 的依赖 —— 现在决定"要不要用镜像"的这一步本身在国内就不稳定，是个死结。

**做法**：同时向官方源和镜像发起请求，谁先响应用谁，另一个 abort（Happy Eyeballs 式）。收益：不需额外探测请求、不依赖第三方服务、自动适配且永远正确、网络抖动时天然容错。

**需仔细设计的点**：

1. 必须在既有的 URL/重定向校验框架内实现（`validateNodeResponseUrl`、`validateCodexDesktopResourceUrl`、`validateGrokArtifactResponseUrl` 各有白名单）。
2. **安全关键**：对于有 SHA-512/签名校验的产物，赛跑只影响"从哪拿字节"，校验照做，安全性不变；但"版本清单"类响应决定要装哪个版本，赛跑可能被恶意镜像影响版本选择 —— 这类是否该赛跑需单独论证。

**替代方案**（更简单）：区域探测改用自家 `api.solov.cc` 或 `updates.shenfengwl.fun` 返回区域标识。

**优先级**：低于 1.2 和 2.4。那两条做完后本条边际收益已不大。

### 2.6 Grok CLI 接入国内镜像（**需先确认基础设施控制权**）

Grok CLI 二进制**完全没有国内镜像**。`grok-installer.ts:20-21` 的 `primaryArtifactRoot='https://x.ai/cli'`、`fallbackArtifactRoot='https://storage.googleapis.com/grok-build-public-artifacts/cli'`，两个源都在境外（Google 对象存储在国内基本不通），**互为回退等于没有回退**。`grok-update.ts:1-2` 同样。用户装 Grok CLI 大概率直接失败。

**有利条件**：项目已有自建镜像基础设施 —— `codexapp.agentsmirror.com`（背后是 `fgws3-ocloud.ihep.ac.cn` 中科院高能所对象存储），Codex 桌面端已完全走镜像，且已实现 S3 签名参数白名单与重定向逐跳校验（`system-service.ts:102-345, 421-433`）。**这是全项目网络处理做得最对的一块，Grok 应照此模式接入，不需要新建基础设施。**

> **待确认**：是否对 agentsmirror 基础设施有控制权、能否往上面放 Grok 二进制？

**实现注意**：`grok-installer.ts` 有完整的 URL 白名单校验（`validateGrokArtifactResponseUrl`）和签名校验，新增镜像源必须**加进白名单而不是放宽校验**。

---

## 批次 3：安全与数据完整性

### 3.1 【高危】提权模式下交互式终端继承未净化环境变量

> **✅ 已落地**（`8c6a476`）：按下述方案参数化了净化基底，trusted-only 传 `trustedCommandEnvironment`（现 `system-service.ts` 的 `launchProviderOperation` Windows 分支），CLAUDE.md I2 已收录该约定。以下为原始分析，留档。

`electron/system-service.ts:3033`，`launchProviderOperation` 的 Windows 分支无条件传 `interactiveTerminalEnvironment()`，trusted-only 与 same-user 共用同一行。

- `interactiveTerminalEnvironment`（188-210）= `commandEnvironment(process.env)` + 删除颜色键 + 重设 5 个颜色变量，**不剥离任何危险变量**。
- 而项目在所有其他高权限子进程处都用 `trustedCommandEnvironment` 剥离 `NODE_OPTIONS` / `NODE_PATH` / `PYTHONPATH` / `npm_config_*` / `BROWSER` / `PAGER` / `GIT_ASKPASS` / `DOTNET_*` 等（`command-runner.ts:207-273`，注释明确写 "must never cross the high integrity boundary"、"an elevated OAuth login must not launch a user-supplied BROWSER command"）。
- `launchCliPowerShell` 把该 env 原样交给 `execFileAsync`（`windows-elevation.ts:384-390`），broker 用 `Start-Process` 无降权（对比专门降权的 `launchUnelevatedCommandWindow`），终端继承提权令牌 + 未净化 env。
- **后果**：node 版 CLI 尊重 `NODE_OPTIONS=--require <用户可写路径>` → **管理员权限任意代码执行**。`assertTrustedElevatedCliCommand`（3026）只校验可执行文件路径，完全不管环境变量，该校验被 env 通道整体绕过。

**已验证的修复方案（改动很小）**：把 `interactiveTerminalEnvironment` 的"基底构造函数"参数化，trusted-only 传 `trustedCommandEnvironment`，颜色层原样叠在上面：

```ts
env: interactiveTerminalEnvironment(
  process.env,
  windowsExecutionMode === 'trusted-only' ? trustedCommandEnvironment : commandEnvironment,
)
```

终端颜色完全不受影响。已验证 `trustedCommandEnvironment` 会用独立解析的机器路径重新注入 `SystemRoot` / `WINDIR` / `SystemDrive` / `ProgramFiles` / `ProgramData` 等（`command-runner.ts:361-368`），终端不会因缺变量而异常。

> **需拍板的功能影响**：`trustedCommandEnvironment` 会把 PATH 里所有用户可写目录过滤掉。所以**以管理员身份运行时**，终端里用户装在个人目录的工具（如便携版 git）会不在 PATH 上。系统目录、Program Files、本软件托管的 npm 目录仍在，CLI 本身按绝对路径启动，主要功能不受影响。这是安全与便利的取舍，且只影响"以管理员身份运行"这一非默认场景。

> **明确不要做**：不要把 `interactiveTerminalEnvironment` 整个换成 `trustedCommandEnvironment` —— 那会连 `TERM`/`FORCE_COLOR` 一起剥掉，终端变无色。必须在净化基底之上保留颜色层。

same-user 模式无需处理（未跨越完整性边界）。

**测试**：`system-service.test.ts:371-392` 现在只断言颜色标志、输入里根本没有 `NODE_OPTIONS`。需补：trusted-only 模式下危险变量被剥离、且颜色变量仍正确设置。

### 3.2 Codex 会话归档失败时的硬链接死锁（会话永久失效）

> **✅ 已落地**（`fd2633c`）：进程内失败路径补齐"同 inode 链接对"分支——可清理时当场清理完成回滚；仍被占用时记 `pending`（而非 `rolled-back`）交给启动恢复，用户可见文案提示关闭占用程序后重启自愈。测试覆盖进程内链接对的三条路径（`codex-sessions.test.ts` 的 refuseUnlink 系列用例）。以下为原始分析，留档。

`electron/codex-sessions.ts:1349-1365`，`changeArchiveState` 的 `moveFileDurably` 是"先 link 目标再 rm 源"两步移动。

失败路径：link 成功后 rm 源失败（Windows 上被杀毒/备份/索引软件以不含 `FILE_SHARE_DELETE` 方式打开，是常态而非罕见），且内部清理 rm 目标也失败（同因相关，`force:true` 只忽略 ENOENT）→ 源与目标同为一个 inode 的两个硬链接，且 `moved=false`。

此时 1354 行回滚条件为 false，跳过修复且不报错，1361 行却写入 `state:'rolled-back'` —— 与实际磁盘状态不符。而启动恢复 `interruptedOperations`（1086-1088）只保留 pending/ready，专为"同 inode 双硬链接"准备的修复逻辑（1185-1195，注释 "A crash between link and rm leaves source and target as hard links"）**永远走不到**。

**后果**：rollout 文件 `nlink=2`，`validateRollout`（453-455，`nlink>1` 抛错）使该会话的详情、导出、归档、恢复**全部永久失效**，连"重新归档以自愈"的路径也被同一校验挡死，只能用户手工删除残留硬链接。

> 讽刺点：同样的磁盘状态若由进程崩溃造成（日志停在 pending），启动恢复反而能修好（已有测试 `codex-sessions.test.ts:424-450` 证明）；唯独这条"进程内失败"路径把状态标成 `rolled-back` 后自断了修复通道。

**做法**（三处必须一起改才自洽）：补全回滚条件加上"同 inode"分支；修正状态写入（不该写 `rolled-back`）；确认启动恢复能覆盖到新状态。

**测试缺口**：唯一的进程内回滚测试（715-732 行）通过 `afterMoveBeforeCommit` 注入失败，此时 `moved` 已为 true，未覆盖本分支。

### 3.3 发布门禁与依赖审计的两处 fail-open

> **✅ 已落地**：发布门禁——`2c53e6d` 缺少期望发布者时抛 `SIGNING_PUBLISHER_MISSING` 拒绝校验（测试 `verify-release-artifacts.test.cjs` "refuses to verify an installer when no expected publisher is configured"）；依赖审计——缺 `resolved` 的普通条目已抛错拒绝（至迟随 `17fef1a` 落地，测试 "rejects ordinary locked packages missing resolved or integrity" 钉住），工作区链接豁免面单独校验。以下为原始分析，留档。

**`scripts/verify-release-artifacts.cjs:93-100`**：`verifyAuthenticode` 仅在 `expectedPublisher` 非空时才比对签名主体。而它来自 `validateReleaseEnvironment()`，当 `XINGMANG_RELEASE` 不为 `'1'` 时为 null。所以直接执行 `npm run release:verify` 而未导出发布环境变量时，**任何持有任意有效签名的安装包都会通过**，并输出"发布产物校验通过"，无降级提示。完整链路 `run-release-build.cjs` 会注入该变量，不受影响。

**`scripts/audit-development-dependencies.cjs:55-56`**：对 `entry.resolved` 不是字符串的条目直接 `continue`，既不校验也不计入。被篡改的锁文件条目只要删除 `resolved` 字段就完全绕过"官方源 + SHA-512"检查，而第 163 行仍宣称"N 个锁定包均来自 npm 官方 HTTPS 源并带 SHA-512"。

**做法**：均改 fail-closed，并报告被跳过的条目数。仅影响发布流程与 CI，不影响客户端运行时。

### 3.4 【需决策·勿贸然改】更新签名发布者从裸 CN 收紧为完整 DN

`electron/update-signature.ts:116-124`，`publisherMatches` 在期望发布者解析不出 DN 键值对时（即裸公司名），**退化为只比对证书 Subject 的 CN**。已实测 `builder-util-runtime` 的 `parseDn('绍兴星芒文化传媒有限责任公司')` 返回空 Map，确实触发退化分支。

触发条件是**当前的标准配置**而非边缘情况：`docs/RELEASING.md:30` 明确指示设置该裸名；`electron-builder.config.cjs:14-15` 默认值也是裸名。

**风险**：证书 CN 非全局唯一。任何受信 CA 给另一同名主体（如境外注册的同名公司）签发的有效证书，Status 为 Valid 且 CN 相同即可通过全部校验。配合更新源被攻破或有效 TLS 中间人，可向全部客户端推送恶意更新并静默安装（`updater.ts:217-226` 下载完成后 300ms 自动 `quitAndInstall`）。

`scripts/verify-release-artifacts.cjs:29-33` 注释明言 "Mirrors electron/update-signature.ts"，**刻意镜像了同样的退化逻辑**，无任何环节强制完整 DN。

> **为什么不能直接改**：旧客户端校验的是裸名。如果新版本证书主体的表述变了，旧客户端可能拒绝安装更新 —— 而它们只能通过更新获得新逻辑，**形成死锁且不可挽回，用户永久失联**。

**安全的迁移路径（至少两个发布周期）**：

1. 先发一个版本，让客户端**同时接受**裸名和完整 DN。
2. 等这个版本铺开到足够比例（需要版本分布数据支撑判断）。
3. 再收紧为只接受完整 DN，同时更新 `docs/RELEASING.md:30`、`electron-builder.config.cjs:14-15`、`scripts/verify-release-artifacts.cjs:29-33` 四处。

**当前风险可控性**：利用需要攻击者同时具备"更新源控制权"和"同名主体的受信证书"，而 HTTPS、禁重定向、SHA-512、blockmap、Valid 状态、路径核对等主防线都完好。所以不急，但要规划。

**短期零风险改进**：在 CN-only 匹配时输出告警日志（对齐上游 electron-updater 行为），不改变校验结果。
（2026-08-10 核实：主体迁移按设计仍未动；~~该告警日志子项也未做~~ → **告警日志子项已落地**（`2aa1774`）：运行时校验器与发布门禁脚本在 CN-only 退化匹配通过时输出告警，判定完全不变、回调抛错被吞，均有测试钉住。）

---

## 批次 4：工程健康

> **基本落地（2026-08-10 核实）**：4.1 ✅ `tsconfig.electron.test.json` 已进 `npm run typecheck` 三段式，存量 53 条错误已清零（`854c1b4`）；4.2 ✅ wrangler 已从依赖树整体移除，6 个漏洞随之消失；4.3 前三条 ✅（MCP/Skills 突变已 invalidate `9761d81`、主题双通道已同步、git 正则退化已修 `7099a83`）；4.3 测试缺口：`ipc.ts` 15 个 parse 函数已补 104 例（`6f57921`）、`error-message.ts` 已有测试，页面组件测试现为 11 个页面中 3 个（仍不全，非阻塞）。以下为原始分析，留档。

### 4.1 让 typecheck 覆盖 electron 下的测试文件

`tsconfig.electron.json:13-14` include `electron/**/*.ts` 但 exclude `electron/**/*.test.ts`；根 `tsconfig.json:20` 只 include `["src", "vite.config.ts"]`。项目无 vitest.config，vitest 裸跑只做转译不做类型检查。结果：**electron/ 下 37 个测试文件不被任何 tsc 检查**。

实测：用 `extends` 主配置且 `exclude:[]` 跑 `npx tsc --noEmit` 报 **53 条 error TS**（基线退出码 0，证明全部来自被排除的测试文件）。抽查确认是真实错误，且 `ipc.test.ts`、`system-service.test.ts` 的 mock 已缺少 `installDirectory`、`uninstall` 等必填属性 —— 生产类型演进后测试 mock 已脱节而无编译期报警。

**做法**：新增 `tsconfig.electron.test.json` 纳入 typecheck 脚本；存量 53 条错误分批清，不要求一次清完。

**价值**：本身不影响用户，但**决定了后续所有批次改动的安全性** —— 防止改动时测试 mock 悄悄脱节。建议在批次 2/3 动手前先完成，作为回归防线。

`exclude` 的原始动机（compile 发射产物时不含测试）依然成立，所以是**新增配置而非删除 exclude**。

### 4.2 wrangler 依赖链的 6 个开发依赖漏洞

`npm audit`（含 dev）报 6 个漏洞（3 高 3 中），全部来自 `wrangler → miniflare → undici` 这条**纯开发依赖链**。`npm audit --omit=dev` 报 0 个，客户端不受影响。

先确认 wrangler 是否还在使用（可能是早期用于 Cloudflare R2 上传更新产物的遗留）—— 不用就删除，比升级省事。**不要运行 `npm audit fix --force`。**

### 4.3 低危问题与测试覆盖缺口（择机处理）

以下均经验证成立但影响较小，不必单独排期：

1. **`src/App.tsx:1104`** —— MCP/Skills 页面的增删改结果可能被在途的列表刷新用旧数据覆盖（幽灵行、开关跳回）。突变回调直接 setState 但从不调用 `pageDataTracker.invalidate`（`latest-request.ts:19-21` 提供了该方法却未被使用）。对比 PluginsPage 突变后总调 `onRefresh` 因而规避了此竞态。可自愈、触发概率低。

2. **`src/App.tsx:1200`** —— 设置页主题预览只更新 `theme` 不同步 `settings.theme`。未保存就离开页面时，预览主题继续生效并已写入 localStorage，而 `settings.theme` 仍是旧值，造成三处状态矛盾。侧边栏切换处（1060-1065）有注释说明"主题双通道必须同步"，唯独预览通道漏了。

3. **`electron/provider-extensions.ts:360`** —— git 来源判定正则的后缀组 `(?:\.git|#ref)?` 可选，导致表达式退化为"只要以 `https://` 开头就匹配"。常见配置 `{command:'npx', args:['-y','mcp-remote','https://example.com/mcp']}` 的端点 URL 被误判为 git 仓库，后续 `enrichUpdates` 直接返回 `latestVersion:null`，npm 版本检查被跳过。应改为 `.*(?:\.git|#[A-Za-z0-9._/-]+)$` 或分别判断。

4. **测试覆盖缺口**（建议随相关改动顺手补）：
   - `electron/ipc.ts:102-333` 的 IPC 输入校验函数（渲染进程不可信输入进主进程的**唯一防线**）大部分零测试：`parseMcpInput` / `parseSkillInput` / `parseProviderExtensionMutation` / `parseSettings` / `parseSessionId` / `parseSessionListQuery` 等，对应通道 handler 在 `ipc.test.ts` 中一次都没被调用。
   - `src/error-message.ts`（71 处调用的错误展示唯一入口）无任何测试，且是 18 行纯函数，**补测成本极低**。
   - `src/pages/` 下 12 个页面组件中仅 2 个有测试且只测抽出的纯函数；`electron/main.ts`、`preload.ts` 无直接测试。

**关于是否引入 DOM 测试设施（jsdom / @testing-library）**：务实建议是**暂不引入**。项目现有模式是把逻辑抽成纯函数再测（如 `cliUninstallPresentation`、`settingsEqual`、`reconcileSettingsDraft`），成本低、收益明确。引入 DOM 测试栈会显著增加维护面，而现有 e2e 冒烟脚本已覆盖"能否启动到首页"。建议继续沿用纯函数抽取模式，优先补 `ipc.ts` 校验函数和 `error-message.ts` 这两处高价值低成本的缺口。

---

## 明确建议「不要改」的三处

1. **npm 官方源 SHA-512 对账**（2.3）—— 防镜像投毒的核心设计，只改体验不改逻辑。
2. **`interactiveTerminalEnvironment` 的颜色变量层**（3.1）—— 修复时最省事的做法是整个换成 `trustedCommandEnvironment`，那会让终端变无色。要在净化基底之上保留颜色层。
3. **Codex 桌面端那套镜像实现** —— 全项目网络处理做得最对的一块（纯镜像 + S3 签名白名单 + 重定向逐跳校验），不要动它，反而应该把 Grok 按它的模式接进来。

---

## 待决策事项

| 事项 | 说明 |
|---|---|
| 3.1 的 PATH 收窄 | 以管理员身份运行时，终端 PATH 会失去用户可写目录。是否可接受？ |
| 2.6 Grok 镜像 | 是否对 agentsmirror 基础设施有控制权、能否放 Grok 二进制？ |
| 3.4 签名 DN 迁移 | 是否启动两个发布周期的迁移计划？需要版本分布数据支撑第二步的时机判断。 |

---

## 附：用户反馈与根因对照

| 用户反馈 | 根因 | 对应改进项 |
|---|---|---|
| 已装 Node.js 但检测不到 | 扫描"一损俱损"，任一探测抛错则全部显示未安装 | 1.1、2.1 |
| 已装 Node.js 但检测不到 | PATH 继承自启动时刻，装完不重启查不到 | 2.2 |
| 已装 Node.js 但检测不到 | 自定义安装目录 / fnm 不在候选清单 | 2.2 |
| 下载慢或失败 | 区域探测失败退回官方源（供需反了） | 1.2、2.4、2.5 |
| 下载慢或失败 | npm 依赖图解析强制走官方源，镜像帮不上忙 | 2.3（只改体验） |
| 下载慢或失败 | Grok CLI 两个源都在境外，无国内镜像 | 2.6 |
| 下载慢或失败 | 不支持代理（企业内网用户） | 优先级最低，见下 |

**关于代理支持**：全仓库只有 `diagnostics.ts:97` 把 `HTTP_PROXY` 等变量名列出来做诊断展示，没有任何地方真正使用。主进程用 Node 原生 fetch（undici），默认不读这些环境变量。可考虑 undici `ProxyAgent` + Electron session 代理 + 透传给 npm 子进程。**但这解决的是公司内网这个小众场景，优先级应低于上表所有项。**

---

## 附：需要下载的资源与镜像现状

| 下载内容 | 官方源 | 国内镜像 | 现状 |
|---|---|---|---|
| Node.js 运行时 | `nodejs.org/dist` | `npmmirror.com/mirrors/node`、`cdn.npmmirror.com/binaries/node` | 已接，顺序依赖区域探测 |
| 四个 CLI 的 npm 包 | `registry.npmjs.org` | `registry.npmmirror.com` | 已接，但依赖图解析强制走官方 |
| Codex 桌面端安装包 | `persistent.oaistatic.com` | `codexapp.agentsmirror.com` | **已接且是唯一源** |
| Codex 桌面端清单 | `persistent.oaistatic.com` | `codexapp.agentsmirror.com` | 已接且已改镜像优先（1.3 已落地，`codex-desktop-service.ts`） |
| **Grok CLI 二进制** | `x.ai/cli` → `storage.googleapis.com` | **无** | 两个源都在境外（见 2.6） |
| **区域探测** | `www.cloudflare.com/cdn-cgi/trace` | **无** | 见 1.2、2.5 |
| MCP 扩展版本查询 | `registry.npmjs.org` / `pypi.org` | 部分 | 非关键路径 |
| 主程序自更新 | `updates.shenfengwl.fun` | 自有域名 | 自己可控 |
| Python | 仅 `openExternal` 打开官网 | — | 不下载，不是问题 |
