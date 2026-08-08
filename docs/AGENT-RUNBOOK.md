# 本地 AI 执行手册

> 这份文件是**贴给本地 AI（Claude Code / Codex）的操作指令**。

---

## 📋 给人类：启动一个 agent 就复制这段

在本地任意目录开 Claude Code / Codex，把下面整段粘进去（**自包含，不需要提前 clone**）：

```
项目仓库：https://github.com/peaker520/xingmang-ai-manager

请按以下步骤执行：
1. 如果当前目录不是这个仓库，把它 clone 下来并 cd 进去；已有则 git checkout main && git pull
2. 读 docs/AGENT-RUNBOOK.md，严格按它的流程执行
3. 从任务索引 Issue #27 里挑一个适合这台机器、且未被认领、依赖已满足、
   非 needs-decision 的任务，认领后开始做

注意：标了 serial-only 的任务，动手前必须确认没有别人正在改同一批文件。
不确定的地方不要猜，在 issue 上留言提问，去做别的任务。
```

**如果已经 clone 好了**，在仓库目录里开会话，说这一句就够：

```
读 docs/AGENT-RUNBOOK.md，按它的流程领一个任务做。
```

---

## 项目坐标

```
仓库：https://github.com/peaker520/xingmang-ai-manager
任务索引：https://github.com/peaker520/xingmang-ai-manager/issues/27
```

---

## 第 0 步：环境准备（第一次必做）

**你必须把代码拉到本地。** 没有本地副本，你无法读代码、跑测试、改文件、提 PR —— 这个流程的每一步都需要真实的工作副本。

### 0.1 克隆并进入仓库

```bash
# 如果还没有本地副本
git clone https://github.com/peaker520/xingmang-ai-manager.git
cd xingmang-ai-manager

# 如果已经有了，确保是最新的
git fetch origin
```

### 0.2 确认文档在位

规范文档已在 `main` 上，clone 下来直接就有：

```bash
ls CLAUDE.md docs/ROADMAP.md docs/COLLABORATION.md
```

三个文件都在就继续。如果缺失，说明你不在 `main`（或 fork 落后），先 `git checkout main && git pull`。

### 0.3 装依赖

```bash
npm ci        # 用 ci 而不是 install，保证与 lock 文件一致
```

### 0.4 确认 GitHub 权限

```bash
gh auth status     # 必须已登录，且对本仓库有 write 权限（能评论、能推分支）
```

如果这台机器用的是 GitHub MCP 而不是 `gh` CLI，把本手册里所有 `gh` 命令换成对应的 MCP 调用（创建 issue 评论、创建 PR 等）。

### 0.5 记录测试基线（macOS/Linux 上必做）

```bash
npm test 2>&1 | tail -5    # 记下失败数
```

**当前基线**（`main` 已合并 macOS 支持后实测）：

**⚠️ 没有任何平台是全绿的。下面这些失败不是你弄坏的：**

| 平台 | 已知失败 | 原因 | 报到哪 |
|---|---|---|---|
| **Windows** | **9** | 4 个需符号链接权限（未开发者模式 + 非管理员 → EPERM）；5 个卡 5s 超时 | **#40** |
| **macOS** | 0 | — | — |
| **Linux** | **1** | `macos-platform.test.ts:249` | **#2** |

耗时也差很多：Linux 约 8 秒，**Windows 上因 Defender 实时扫描可能要 60~90 秒**，不是卡死。

⚠️ **Linux 那 1 个不是「门控写漏」，是真实缺陷。** 它断言"不要删掉别人放在启动器路径上的文件"，
而这条属性确实不成立（`samePathIdentity` 只比 `dev/ino/uid`，Linux tmpfs 复用 inode 后误判）。
**绝对不要用 `it.runIf(darwin)` 把它跳过**——那是把缺陷藏起来。修法见 Issue #2。

**把你这台机器的实际失败数记住** —— 后面验证改动时要对比，确保没引入新失败。

如果实际数字与上表不符：Windows 上报到 **#40**，Linux 上报到 **#2**，macOS 上**新开一个 issue**。不要直接开始改。

---

## 你是谁

你的身份由三部分决定，PR 标题和分支名都要用到：

- **GitHub 用户名**：`gh auth status` 里显示的
- **AI**：`claude` 或 `codex`
- **端**：`win` / `mac` / `linux`

```bash
node -e "console.log(process.platform)"   # win32 → win，darwin → mac
```

---

## 第 1 步：读三份文件

按顺序：

1. **`docs/ROADMAP.md`** —— 整个项目在做什么、为什么。**这是背景，理解它再动手。**
2. **`CLAUDE.md`** —— 代码架构、14 条关键不变量（破坏后不报错、只会静默变漏洞）、11 条改动陷阱。**这是保命的，必须读完。**
3. **`docs/COLLABORATION.md`** —— 分支/PR 格式、冲突规避、验证门槛。

读完再往下。

---

## 领任务的循环

### 1. 看有哪些任务适合你

**任务索引是 GitHub Issue #27**，先看它了解全貌。然后按你的环境筛选：

```bash
# 看所有开着的任务
gh issue list --state open --limit 50

# 只看适合你这台机器的（按你的端选标签）
gh issue list --label "env:macos" --state open    # 你在 Mac
gh issue list --label "env:windows" --state open  # 你在 Windows
gh issue list --label "env:any" --state open      # 任意平台都行
```

⚠️ **标签名只有这四个：`env:any` / `env:windows` / `env:macos` / `env:server`。**
写错了 `gh` **不报错**——它返回空列表、退出码 0，你会以为「没有适合我的任务」。
筛出来是空的时候，先 `gh label list` 核对一遍标签名，再下结论。

### 2. 判断这个任务能不能领

一个任务**可以领**，当且仅当全部满足：

- [ ] `env:` 标签匹配你的机器（`env:windows` 的任务，Mac 上领了也没法验证）
- [ ] 没有被别人认领（issue 里没有「开始处理」的评论，或最近的认领已明显放弃）
- [ ] 它的**前置依赖已经合并**（issue 正文会写「依赖 #X」，去确认 #X 已 closed）
- [ ] 如果它标了 `serial-only`：**确认此刻没有别人正在改同一批文件**（见下方「serial-only 铁律」）
- [ ] 如果它标了 `needs-decision`：**停下，这条需要人来拍板，不要自己决定**。在 issue 上留言说明卡在哪个决策点，然后去领别的

### 3. 认领（防止两个 agent 撞同一个任务）

```bash
gh issue comment <编号> --body "🤖 开始处理 —— <用户名>/<ai>-<端>"
```

**认领后先刷新一次**，确认没有别人在你之前几秒也认领了。如果撞了，谁的评论时间早谁做，另一个换任务。

### 4. 建分支

**开发分支永远从最新的 `main` 拉**：

```bash
git fetch origin
git checkout main && git pull
git checkout -b <用户名>/<ai>-<端>/<简短英文描述>
# 例：xufei5620/claude-mac/gate-darwin-tests
```

### 5. 干活

- **严格按 issue 正文的「做法」和「验收标准」**
- 遇到 issue 里写的「❌ 明确不要做」，**绝对不要碰**——那些是踩过坑的红线
- 涉及安全边界（`command-runner` / `windows-elevation` / `trusted-*` / `config-files`）的改动，先在测试里写清楚「为什么安全」
- **不确定的地方不要猜**：在 issue 上提问，去做别的，等人回答

### 6. 验证（硬门槛，两条都要过）

```bash
npm run typecheck
npm test
```

⚠️ **对比失败数，不要只看"红没红"**：先在干净的 `main` 上 `npm test` 记下失败数（基线见第 0.5 步），再在你的分支上对比。Linux 上那 1 个已知失败在 #2 修好前会一直红。

平台相关的改动，还要按 issue 要求做手工验证。

### 7. 提 PR

```bash
gh pr create \
  --title "[<用户名>·<ai>·<端>] <类型>: <描述>" \
  --body "Closes #<编号>

## 提交来源
- 开发者：@<用户名>
- AI：Claude Code / Codex
- 环境：<Windows/macOS>（本地）

## 改动内容
<做了什么>

## 验证方式
- [x] npm run typecheck 通过
- [x] npm test（平台：___，失败数 前___ / 后___）
- [x] 手工验证：___"
```

`<类型>`：`feat` / `fix` / `docs` / `refactor` / `test` / `chore` / `perf`
`Closes #<编号>` 会在 PR 合并时自动关掉对应 issue。

### 8. 回到第 1 步，领下一个

---

## ⛔ serial-only 铁律

标了 `serial-only` 的任务，**同一时间只能有一个人做**。涉及：

- **IPC 三件套**（`ipc-contract.ts` / `ipc.ts` / `preload.ts`）
- **`src/styles.css`**
- **`system-service.ts` / `App.tsx` 的结构性改动**

**为什么**：`ipc.test.ts:222` 断言 IPC 注册顺序与契约键顺序逐项相等。两个人并行加通道，**即使 git 文本合并干净，CI 也一定红**。

**怎么协调**（没有中央调度，靠约定）：

1. 领 `serial-only` 任务前，先看有没有别的**同类** `serial-only` 任务处于「已认领但未合并」状态
2. 有的话，等它合并再领
3. 你领了之后，尽快做完提 PR，不要占着不动
4. **特别注意**：#18（对接 new-api）和 #21（画布）都会加 IPC 通道，**绝对不能同时开工**

---

## 遇到这些情况怎么办

| 情况 | 怎么办 |
|---|---|
| Issue 标了 `needs-decision` | **不要做**。留言说明卡在哪，去领别的 |
| 依赖的前置 issue 还没合并 | 不要领，等它合并 |
| 改到一半发现要动 `serial-only` 文件，但没预料到 | 停下，在 issue 上说明，确认没人在改那些文件再继续 |
| 发现一个 issue 里没写的新问题 | **单独开一个 issue**，不要顺手在当前 PR 里改 |
| `npm test` 红了，不确定是不是自己改的 | 在干净的 `main` 上跑一遍对比失败数 |
| 看到根目录冒出 `\tmp\xingmang-managed-cli-*` 目录 | 已知 bug 的产物，`rm -rf` 删掉，**不要提交**（#3 会根治） |
| 完全卡住 | 在 issue 上留言描述卡点，标记 `@<人类用户名>`，去领别的 |

---

## 「轮询」怎么实现

你不会自动收到新任务通知。有两种方式让你持续干活：

**方式 A：人工驱动（推荐先用这个）**
人类在你的会话里说一句「看看有没有你能做的任务」，你就跑一遍上面的循环。做完一个 PR，人类再说一句，你做下一个。

**方式 B：定时轮询**
如果你的 Claude Code 支持 `/loop` 之类的定时任务，可以设成每隔一段时间跑一次：
```
/loop 30m 检查 gh issue list --label env:macos --state open
      （Windows 上换成 env:windows；标签名只有 env:any / env:windows / env:macos / env:server），
      挑一个未认领、依赖已满足、非 needs-decision 的任务，按 docs/AGENT-RUNBOOK.md 执行
```
⚠️ 但定时轮询要**特别小心 serial-only 冲突**——无人盯着的自动执行最容易两个 agent 撞 IPC。建议定时轮询只用于领 `env:any` 且非 `serial-only` 的安全任务。

---

## 建议的起手顺序（第一周）

如果你是**第一个**开始的 agent，按这个优先级挑：

1. **#5**（Windows 上做）—— 高危 RCE，改动小，决策已拍板
2. **#2**（任意平台，Linux/Mac 可直接复现）—— 修 `samePathIdentity`，顺带拿回绿色基线
3. **#37 #38**（Mac 上做）—— macOS 新代码的两处信任链缺口
4. **#30**（任意，但 serial-only）—— 拆 App.tsx，越早做完后面越顺
5. **#28 的回滚 runbook** —— 发版止损能力

**#30 没合并前，不要领 #10 #17 #18 #21**（它们都要改 App.tsx，会和 #30 冲突）。

---

## 记住三件事

1. **`CLAUDE.md` 的 14 条不变量是红线**——破坏它们不会报错，只会让用户的电脑变成漏洞。
2. **纯搬运的重构（#30 #32）不能夹带逻辑改动**——见 `COLLABORATION.md` 的规范。
3. **不确定就问，不要猜**——留言在 issue 上，去做别的，等人回答。
