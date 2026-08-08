# 多 Agent 协作规范

本项目由多名开发者 + 多个 AI 编码 agent 并行开发。本文档定义任务分发、分支、提交与验证规范。

> 🤖 **如果你是 AI agent 且要立刻开始干活，直接看 [`docs/AGENT-RUNBOOK.md`](./AGENT-RUNBOOK.md)** —— 那是可执行的操作手册（领任务 → 干活 → 提 PR 的完整流程）。本文档是规范细则，供查阅。
>
> 动手前必读 `CLAUDE.md`（架构地图、关键不变量、改动陷阱）。

---

## 1. 参与方

| 角色 | 环境 | 职责 |
|---|---|---|
| 云端 Claude | 云端会话 | 规划、架构决策、规范维护、创建与分发 Issue。**不直接改业务代码** |
| Claude Code | 本地 Windows | 需要 Windows 真实环境验证的任务 |
| Claude Code | 本地 macOS | Mac 适配、跨平台任务 |
| Codex | 本地 | 与平台无关的任务、新产品线 |

> 参与方会增加。所有标识都用词表，加人加 AI 只需扩词表，不改规范。

**词表**
- `<ai>`：`claude` / `codex` / `human`（纯人工改动也要能标）
- `<端>`：`win` / `mac` / `cloud` / `linux`

---

## 2. 任务分发：GitHub Issues 作为任务队列

云端无法推送任务给本地 agent，所以任务写进 Issue，**本地 agent 主动拉取**。

### 标签体系

| 标签 | 含义 |
|---|---|
| `agent:win` / `agent:mac` / `agent:codex` / `agent:cloud` | 指派给哪个环境 |
| `batch:0` … `batch:4` | 对应 `docs/IMPROVEMENT-PLAN.md` 的批次 |
| `needs-decision` | 阻塞，等人类决策，agent 不要动 |
| `serial-only` | **必须串行**，同一时间只能有一个人做（见第 4 节） |
| `blocked` | 依赖其他 Issue 先完成 |

### 本地 agent 的循环

```bash
# 1. 拉取指派给自己且未被认领的任务
gh issue list --label agent:mac --state open

# 2. 认领（留言，避免重复认领）
gh issue comment <n> --body "开始处理 — claude/mac"

# 3. 建分支
git checkout main && git pull
git checkout -b <github-用户名>/<ai>-<端>/<简短描述>

# 4. 开发 → 验证（见第 5 节硬门槛）

# 5. 提 PR
gh pr create --title "[<用户名>·<ai>·<端>] <类型>: <描述>" --body "..."
```

**认领规则**：动手前必须在 Issue 上留言。看到已有他人认领留言的 Issue，跳过。

---

## 3. 分支与提交规范

### 分支名

```
<github-用户名>/<ai>-<端>/<简短描述>

例：peaker520/claude-mac/fix-cross-platform-tests
    peaker520/claude-win/mirror-fallback
    peaker520/claude-cloud/add-claude-md
    <对方用户名>/codex/provider-registry
```

### PR 标题

```
[<用户名>·<ai>·<端>] <类型>: <描述>

例：[peaker520·claude·mac] fix: 给 Windows 专有测试加平台门控
    [peaker520·claude·cloud] docs: 增加 CLAUDE.md
```

`<类型>` 用约定式提交：`feat` / `fix` / `docs` / `refactor` / `test` / `chore` / `perf`

### PR 正文

使用 `.github/pull_request_template.md`，必填「提交来源」与「验证方式」。

### 提交粒度

- **一个 PR 只做一件事。** 顺手修的无关问题请单开 Issue
- 不要在同一个 PR 里混合「重构」和「功能改动」——review 时无法区分行为变化

### 纯搬运重构的特殊规范（#30 #32 这类）

拆文件、收口常量这类重构，**风险不在写错逻辑，在于夹带了逻辑改动却没人发现**。所以：

1. **纯搬运的 PR，diff 里不能有任何行为改动。** 只能是「删 N 行 + 新文件 N 行 + import 调整」。看到 diff 里出现新的条件判断、改了默认值、调了顺序 —— 一律打回。
2. **搬运与改逻辑必须拆成两个 PR。** 如果一个模块既要搬走又要改，先提「纯搬运」PR 合并，再提「改逻辑」PR。
3. **验证方式写明「零行为变化」**：现有测试全绿 + e2e smoke 通过，不新增也不修改断言（除非断言本身跟着文件路径走）。
4. review 时的判据：**如果 reviewer 需要理解业务逻辑才能确认这个 PR 安全，那它就不是纯搬运，退回重拆。** 纯搬运应该「肉眼扫一遍就知道没动逻辑」。

---

## 4. 冲突规避（重要）

四个 agent 并行的最大风险不是 git 冲突，而是**文本合并成功但语义冲突**。

### 4.1 必须串行的改动（标 `serial-only`）

**① 新增/删除/移动 IPC 通道**

`ipc.test.ts:222` 断言 `ipcMain.handle` 的注册顺序与 `ipcInvokeChannels` 键顺序**逐项相等**（数组 `toEqual` 对顺序敏感）。

> ⚠️ **两个 agent 各自加一个通道，即使 git 文本合并干净，CI 也一定红。**

涉及 `ipc-contract.ts` / `ipc.ts` / `preload.ts` 三件套的任务，同一时间只能有一个人在做。

**② 修改 `src/styles.css`（6027 行）**

单文件、无模块化、全局作用域。两个 agent 同时加样式几乎必冲突。

**③ 大范围重构枢纽文件**

`electron/system-service.ts`（3300 行）、`src/App.tsx`（2855 行）的结构性改动。

### 4.2 热点文件警示

| 文件 | 行数 | 说明 |
|---|---|---|
| `src/styles.css` | 6325 | 全局样式，无模块化 |
| `electron/system-service.ts` | 3753 | 多条待办落在这一个文件上；#34 会搬走约 1100 行 |
| `src/App.tsx` | 2952 | 全部全局状态 + 14 个内嵌组件（`App()` 本体 985 行 / 39 个 useState）|

**分配任务时，尽量不要让两个 agent 同时改同一个热点文件。**

### 4.3 可安全并行的轨道

四条轨道互不重叠，可同时推进：

1. **`system-service.ts` 独占轨** — 一次只有一个人
2. **`electron/` 叶子模块轨** — `config-files` / `codex-sessions` / `grok-*` / `node-runtime` 等
3. **`scripts/` 与 CI 轨** — 发布脚本、workflow
4. **测试与类型轨** — 平台门控、tsconfig、测试补全

---

## 5. 验证硬门槛

**提 PR 前必须跑，两条都要过：**

```bash
npm run typecheck
npm test            # Linux ~8s；Windows 上因 Defender 实时扫描可达 60~90s，不是卡死
```

### 平台差异（重要）

| | Windows | macOS | Linux |
|---|---|---|---|
| `npm run typecheck` | ✅ | ✅ | ✅ |
| `npm test` | ✅ 全绿 | ✅ 全绿 | ⚠️ **1 个已知失败**（见 #2） |
| `npm run compile` | ✅ | ✅ | ✅ |
| `npm run build`（打包） | ✅ Windows 包 | ✅ mac 包（`build:mac:dir`） | ❌ |
| e2e smoke | ✅ | ⚠️ 未验证 | ⚠️ 未验证 |

> **Linux 上那 1 个失败是真实缺陷，不是门控写漏**（`macos-platform.test.ts:249`，`samePathIdentity` 只比 `dev/ino/uid`）。
> **不要用 `it.runIf(darwin)` 跳过它**。详见 Issue #2。
> 无论在哪个平台，**都要对比改动前后的失败数是否一致**，不要引入新失败。

### 只能在特定平台验证的改动

- **只能 Windows 验证**：提权逻辑、PowerShell 调用、注册表、Codex 桌面端（Appx）、Grok 安装、真实 CLI 安装流程
- **只能 macOS 验证**：Mac 适配相关的一切
- **任意平台**：纯函数、类型、脚本、文档、CI 配置

**派任务时按这个表来。** 让 Mac agent 去改提权逻辑，它无法验证自己的改动。

---

## 6. 分工

**两位开发者均覆盖全部产品线**，不做产品线切分。因此分派任务的依据不是「谁负责哪块」，而是下面三条，**按顺序判断**：

### 6.1 先看环境（硬约束）

| 任务类型 | 只能派给 |
|---|---|
| 提权 / PowerShell / 注册表 / Appx / 真实 CLI 安装流程 | **有 Windows 环境的** |
| Mac 适配相关的一切 | **有 macOS 环境的** |
| 纯函数 / 类型 / 脚本 / 文档 / CI / 后端对接 | 任一 |

**派错了对方无法验证自己的改动，PR 不可信。** 详见 §5 的验证能力矩阵。

### 6.2 再看冲突（见 §4）

**同一时间，同一热点文件只能有一个人。** 因为不再有「各管一摊」的天然隔离，这条比以前更关键：

- IPC 三件套（`ipc-contract.ts` / `ipc.ts` / `preload.ts`）→ `serial-only`
- `src/styles.css`（6027 行）→ `serial-only`
- `system-service.ts`(3300) / `App.tsx`(2855) 的结构性改动 → `serial-only`

### 6.3 最后看熟悉度

安全边界相关的改动（`command-runner.ts` / `windows-elevation.ts` / `trusted-*.ts` / `config-files.ts` / `safe-local-data.ts`），**优先由更熟悉现有代码库的人主导或 review**。

理由：这个项目的复杂度集中在 Windows 提权 / 可信路径 / 原子写入这套不变量上（见 `CLAUDE.md` 第 4 节），**破坏它们不会报错，只会静默变成漏洞**。上下文成本很高，不适合边学边改。

### 6.4 云端 Claude 的定位

规划、架构决策、规范维护、Issue 创建与分发、竞品与开源方案调研。**不直接改业务代码**——无法在真实平台验证，且容器是临时的。

---

## 7. 云端 agent 的职责边界

云端会话**不直接改业务代码**，原因：

- 无法在真实 Windows/macOS 环境验证
- 容器是临时的，无法持续跟进

云端负责：
- 架构决策与技术选型
- 创建、拆分、分发 Issue
- 维护 `CLAUDE.md` / `docs/*.md` 等规范文档
- Review PR 的架构合理性

---

## 8. 常见问题

**Q：看到仓库根目录出现 `\tmp\xingmang-managed-cli-*` 目录？**
A：已知 bug（`managed-cli.test.ts` 在非 Windows 平台每跑一次泄漏若干个）。**直接删除，不要提交。** 根治见 `docs/IMPROVEMENT-PLAN.md` 批次 0。

**Q：我的改动需要加 IPC 通道，但有人正在改 IPC？**
A：等待。IPC 三件套是 `serial-only`，见 4.1。

**Q：测试在我的平台上是红的，怎么判断是不是我改坏的？**
A：先在干净的 `main` 上跑一遍记下失败数，再对比。批次 0 修完后此问题消失。

**Q：能不能顺手把某个不规范的地方改了？**
A：不要。单开 Issue。混合改动会让 review 无法区分行为变化。
