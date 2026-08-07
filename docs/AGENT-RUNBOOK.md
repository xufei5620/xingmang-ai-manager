# 本地 AI 执行手册

> 这份文件是**贴给本地 AI（Claude Code / Codex）的操作指令**。开一个新会话时，把这份文件的内容或链接给它，它就知道怎么自主领任务、干活、提 PR。

---

## 你是谁

你是本项目的一个开发 agent，运行在某台设备上。你的身份由三部分决定：

- **GitHub 用户名**：`<你登录 gh 的用户名>`
- **AI**：`claude` 或 `codex`
- **端**：`win` / `mac` / `linux`（你现在这台机器）

**先确认身份**：
```bash
gh auth status          # 确认已登录，记下用户名
node -e "console.log(process.platform)"   # win32/darwin/linux
```

---

## 第一次进这个仓库，先读三份文件

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
gh issue list --label "env:mac" --state open      # 你在 Mac
gh issue list --label "env:windows" --state open  # 你在 Windows
gh issue list --label "env:any" --state open      # 任意平台都行
```

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

```bash
git fetch origin
git checkout main && git pull
git checkout -b <用户名>/<ai>-<端>/<简短英文描述>
# 例：peaker520/claude-mac/gate-windows-tests
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

⚠️ **在 macOS/Linux 上**：批次 0（#2 #3）合并前，`npm test` 有 17 个已知失败。**你要对比改动前后失败数是否一致**，不能引入新失败。方法：先在干净的 `main` 上 `npm test` 记下失败数，再在你的分支上对比。

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
/loop 30m 检查 gh issue list --label env:<你的端> --state open，
      挑一个未认领、依赖已满足、非 needs-decision 的任务，按 docs/AGENT-RUNBOOK.md 执行
```
⚠️ 但定时轮询要**特别小心 serial-only 冲突**——无人盯着的自动执行最容易两个 agent 撞 IPC。建议定时轮询只用于领 `env:any` 且非 `serial-only` 的安全任务。

---

## 建议的起手顺序（第一周）

如果你是**第一个**开始的 agent，按这个优先级挑：

1. **#2 #3 #4**（Mac 上做）—— 解除所有 agent 的验证能力，最高优先
2. **#5**（Windows 上做）—— 高危 RCE，改动小
3. **#30**（任意，但 serial-only）—— 拆 App.tsx，越早做完后面越顺
4. **#28 的回滚 runbook** —— 发版止损能力

**#30 没合并前，不要领 #10 #17 #18 #21**（它们都要改 App.tsx，会和 #30 冲突）。

---

## 记住三件事

1. **`CLAUDE.md` 的 14 条不变量是红线**——破坏它们不会报错，只会让用户的电脑变成漏洞。
2. **纯搬运的重构（#30 #32）不能夹带逻辑改动**——见 `COLLABORATION.md` 的规范。
3. **不确定就问，不要猜**——留言在 issue 上，去做别的，等人回答。
