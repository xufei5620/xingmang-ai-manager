# 多 Agent 协作规范

本项目由多名开发者 + 多个 AI 编码 agent 并行开发。本文档定义任务分发、分支、提交与验证规范。

> 🤖 **如果你是 AI agent 且要立刻开始干活，直接看 [`docs/AGENT-RUNBOOK.md`](./AGENT-RUNBOOK.md)** —— 那是可执行的操作手册（领任务 → 干活 → 提 PR 的完整流程）。本文档是规范细则，供查阅。
>
> 动手前必读 `AGENTS.md`（架构地图、关键不变量、改动陷阱）。

---

## 1. 参与方

| 角色 | 环境 | 职责 |
|---|---|---|
| 云端 Claude | 云端会话 | 规划、架构决策、规范维护、创建与分发 Issue；也直接改业务代码、开 PR（边界见 §7） |
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

> 2026-08-10 拍板：环境标签**以 `env:*` 为唯一标准**（与 `docs/AGENT-RUNBOOK.md` 一致）。
> 早期文档写过 `agent:win/mac/codex/cloud` 一套，已废弃——环境要求是任务的内在属性，
> 与哪个 agent 来做无关。GitHub 上若还残留 `agent:*` 标签，见到即改为对应 `env:*`。

| 标签 | 含义 |
|---|---|
| `env:any` / `env:windows` / `env:macos` / `env:server` | 任务要求的执行环境 |
| `batch:0` … `batch:4` | 对应 `docs/IMPROVEMENT-PLAN.md` 的批次 |
| `needs-decision` | 阻塞，等人类决策，agent 不要动 |
| `serial-only` | **必须串行**，同一时间只能有一个人做（见第 4 节） |
| `blocked` | 依赖其他 Issue 先完成 |

### 本地 agent 的循环

```bash
# 1. 拉取适合本机环境且未被认领的任务
gh issue list --label env:macos --state open

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

> #30（拆 legacy `App.tsx`）已随 legacy 冻结于 2026-09-19 关闭，这里留作范式说明。

拆文件、收口常量这类重构，**风险不在写错逻辑，在于夹带了逻辑改动却没人发现**。所以：

1. **纯搬运的 PR，diff 里不能有任何行为改动。** 只能是「删 N 行 + 新文件 N 行 + import 调整」。看到 diff 里出现新的条件判断、改了默认值、调了顺序 —— 一律打回。
2. **搬运与改逻辑必须拆成两个 PR。** 如果一个模块既要搬走又要改，先提「纯搬运」PR 合并，再提「改逻辑」PR。
3. **验证方式写明「零行为变化」**：现有测试全绿 + e2e smoke 通过，不新增也不修改断言（除非断言本身跟着文件路径走）。
4. review 时的判据：**如果 reviewer 需要理解业务逻辑才能确认这个 PR 安全，那它就不是纯搬运，退回重拆。** 纯搬运应该「肉眼扫一遍就知道没动逻辑」。

---

## 4. 冲突规避（重要）

四个 agent 并行的最大风险不是 git 冲突，而是**文本合并成功但语义冲突**。

### 4.1 必须串行的改动（标 `serial-only`）

**① 修改 `src/styles.css`（约 8000 行）**

单文件、无模块化、全局作用域。两个 agent 同时加样式几乎必冲突。

**② 大范围重构枢纽文件**

`electron/system-service.ts`（约 2900 行）、`src/App.tsx`（约 1800 行）的结构性改动。

**③ legacy 渲染层已冻结**

`src/` 下除 `src/renderer-v2/` 以外的源码与 `tooling/legacy-renderer/` 自 2026-09-19 起**只接受安全修复**（审查总表 `R-S12`，yoyo 拍板）。`src/styles.css` 与 `src/App.tsx` 因此基本不再是并行冲突点——它们的结构性重构不做了。口径见 `AGENTS.md` T14 与 `.claude/rules/legacy-renderer.md`。

### 4.2 热点文件警示

| 文件 | 行数（2026-08-10 实测） | 说明 |
|---|---|---|
| `src/styles.css` | 7984 | 全局样式，无模块化 |
| `electron/system-service.ts` | 2935 | Codex 桌面端部分已按 #34 搬入 `codex-desktop-service.ts` |
| `src/App.tsx` | 1793 | 全局状态枢纽；内嵌组件已拆到 `src/components/` 各子目录 |

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
npm test            # Windows 因 Defender 实时扫描明显慢于 Linux，不是卡死（命令已内置串行 + 30s 超时）
```

### 平台差异（重要）

| | Windows | macOS | Linux |
|---|---|---|---|
| `npm run typecheck` | ✅ | ✅ | ✅ |
| `npm test` | ⚠️ 本机 9 个已知失败（符号链接 `EPERM`，见下）；CI 全绿 | ✅ 全绿 | ✅ 全绿 |
| `npm run compile` | ✅ | ✅ | ✅ |
| `npm run build`（打包） | ✅ Windows 包 | ✅ mac 包（`build:mac:dir`） | ❌ |
| e2e smoke | ✅ | ✅（CI `macos-test` job 跑 dev-origin 与免费分发构建） | ⚠️ 需本机 chromium（容器版本不符时设 `XINGMANG_E2E_CHROMIUM=<chromium 路径>` 复跑） |

> （2026-10-08 校准：Windows 本机基线是 **9 个失败**，全是测试建符号链接时报 `EPERM`——没开开发者模式、也不是管理员时缺这项权限，见 #40 与 `docs/TEST-BASELINE.md`；CI 的 Windows 作业开了开发者模式，所以是 0。macOS、Linux 是 0，历史上 Linux 的 1 个已知失败已随 `sameLocalPathIdentity` 重写修复。）
> 无论在哪个平台，**都要对比改动前后的失败数是否一致**——Windows 本机基线是 9，其他是 0，多出来的就是新失败。

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

- `src/styles.css`（6027 行）→ `serial-only`
- `system-service.ts`(3300) / `App.tsx`(2855) 的结构性改动 → `serial-only`

### 6.3 最后看熟悉度

安全边界相关的改动（`command-runner.ts` / `windows-elevation.ts` / `trusted-*.ts` / `config-files.ts` / `safe-local-data.ts`），**优先由更熟悉现有代码库的人主导或 review**。

理由：这个项目的复杂度集中在 Windows 提权 / 可信路径 / 原子写入这套不变量上（见 `AGENTS.md` 第 4 节），**破坏它们不会报错，只会静默变成漏洞**。上下文成本很高，不适合边学边改。

### 6.4 云端 Claude 的定位

规划、架构决策、规范维护、Issue 创建与分发、竞品与开源方案调研，也**直接改业务代码**。无法在真实平台验证、容器是临时的这两点靠 §7 的流程补上。

---

## 7. 云端 agent 的职责边界

> 2026-10-08 按实践校准：这里原先写「云端不直接改业务代码」，实际上云端分支一直在改 `electron/` 等业务代码、经 PR 合入（如 #944、#945），文档跟实践走。

云端会话**可以直接改业务代码**。原先不让改的两条理由仍然成立，改成靠流程补上：

- **无法在真实 Windows/macOS 环境验证** → 开 PR 前照 §5 与 `AGENTS.md` 第 3 节跑完自查；只能在 Windows / macOS 上验证的部分，以 PR 上 `quality` 工作流对应平台作业的结果为准，挂了看日志修。CI 也覆盖不到的（真机装包、`test:mac:visual` 这类），照 §5、§6.1 交给有对应环境的本地 agent 或开发者验证。
- **容器是临时的** → 进度只留在分支和 PR 上，不留在容器里。

云端还负责：
- 架构决策与技术选型
- 创建、拆分、分发 Issue
- 维护 `AGENTS.md` / `docs/*.md` 等规范文档
- Review PR 的架构合理性

---

## 8. 常见问题

**Q：我的改动需要加 IPC 通道，但有人正在改 IPC？**
A：不用等。`ipc.test.ts` 排序后比对注册的通道和契约，新通道放在哪一行都行；三处（`ipc-contract.ts` / `ipc.ts` / `preload.ts`）保持一致即可，见 `AGENTS.md` T1。

**Q：测试在我的平台上是红的，怎么判断是不是我改坏的？**
A：Windows 本机基线是 9 个失败（全是符号链接 `EPERM`），macOS、Linux 与 CI 是 0（见 §5）。超出基线的先在干净的 `main` 上复跑确认，仍红即为环境或新回归，不要带着红提交。

**Q：能不能顺手把某个不规范的地方改了？**
A：不要。单开 Issue。混合改动会让 review 无法区分行为变化。
