# 交接快照

> 本文件 = 会话之间的**当前状态快照**，不是流水账。**时效性文档：与 CLAUDE.md 或代码冲突时一律以代码为准。**
> 接手方式：`git checkout main` + 读完本文件即可开工。历史流水（2026-08-10 的「滚动报告」版本）留在 git 历史里，需要时 `git log -- HANDOFF.md` 翻。

**快照时间：2026-09-18** ｜ `main` = `43e09af` ｜ 发布版本 = **0.2.6**（2026-09-19）

---

## ① 代码与发布现状

- `main` 停在 `43e09af`「升级 0.2.6，完善客户端接入与账号稳定性 (#128)」，`package.json` 与 `release-notes.md` 都是 0.2.6，三者一致。
- 最近六次发布（均已在 main 上）：
  - **0.2.6**（9-19）接入 WorkBuddy / Claude Desktop / OpenCode 的安装配置与启动；账号切换的配置归属与凭据隔离加固 + 会话 vault 恢复；CI 质量门禁改为按改动范围跑 Windows/macOS/Linux + 依赖审计。
  - **0.2.5**（9-16）Codex 配置不再预设上下文窗口/压缩阈值；关窗可选缩托盘或强制退出。
  - **0.2.4** macOS 游戏加速（M 系列 + Intel，线路选择/延迟检测，每账号本机免费 20 分钟）。
  - **0.2.3** Windows 内置游戏加速线路；Codex 中文注入修复；默认模型换代。
  - **0.2.2** 公告合集拆单篇 + 按账号已读；余额统一自动刷新；调用详情补全并接入 Sub2API 费用拆分。
  - **0.2.1** 账号自动识别与多账号隔离，按工具分组签发专属 Key。
- **双账号域（new-api + sub2api）已经在 main 上跑通**：`electron/relay-sites.ts` 有 `solov`(xm.solov.cc / new-api) 与 `solov-api`(api.solov.cc / sub2api) 两个站点条目，realm 隔离、独立 vault、`sub2api-account-client.ts` 全链都在 main。**注意**：2026-08 期间文档里「api.solov.cc 只做粘贴 Key（manual-key）」的说法已经作废，那是 W3 阶段的中间态。
- **发版日志有两份，用途不同**：`release-notes.md` 面向用户、打包时写进更新清单并显示在客户端更新页（`docs/RELEASING.md`），覆盖 0.1.20 ~ 0.2.6；`CHANGELOG.md` 面向开发者、无程序消费者，**中间断档 0.1.13 ~ 0.2.5**（0.1.12 之后直接跳到 #128 补的 0.2.6）。发版时两份都要更新。

## ② 线上 PR 与 Issue

**Open PR 5 个（2026-09-18 对 `43e09af` 复核）**

| PR | 状态 | 结论 |
|---|---|---|
| #119 `docs: CLAUDE.md 纯搬运瘦身（412→303 行）` | open，落后 main 6 个提交 | **仍有效**。`merge-tree` 对 `43e09af` 试合仍零冲突——CLAUDE.md 自它的 base(`ec26b33`) 起在 main 上没被动过。 |
| #118 `feat(account): 双账号域长期并存改造` | draft，落后 main 6 个提交 | **已被 main 吸收并超越**。23 个文件里 10 个与 main 逐字节相同，其余全是 main 更新（`requireXmSiteRuntimeDefinition` → `requireSiteRuntimeDefinition`、sub2api 正式启用、公告/Key profile/登录提示，0.2.6 又加了 vault 恢复）。 |
| #84 `Add CodexDualRouter Electron handover package` | draft，落后 main 53 个提交 | **无代码价值**。只有一个 152 KB 的 zip 附件（`docs/handover/codex-dual-router/...zip`），main 上没有它，全仓也没有任何 `CodexDualRouter` 引用。关 PR 不会丢东西，分支还在。 |
| #127 `fix(canvas): 简化生成前确认与能力预检（R2-A）` | draft，9-18 开 | 画布重构 R2-A，关联 #126。本次未评估。 |
| #125 `docs: 增加无限画布预览与交付说明` | draft，9-17 开 | 画布预览交付说明，关联 #126。本次未评估。 |

**Open Issue 22 个**。除 9-18 新开的 #126（画布重构 R1：简易创作与高级画布共用工程/运行/资产内核，关联 #80，PR #125 / #127 是它的产出）外，其余最后一次活动都停在 2026-08-18（#92）。任务索引 **#27** 自 2026-08-10 起没更新过，里面的「下一步」已经不反映 0.2.x 的实际进度，**领任务前先自己对一遍 main**。其余分布：8 个带 `defer:macos-release`（#16/#37/#38/#39/#41/#44/#56/#57，全是 macOS 安全边界与资源泄漏）、#92（画布行业模板包 + macOS 画布适配验证，无标签）、#40 Windows 测试基线、#30 拆 App.tsx、#80/#89 画布 v2、#28/#26 发布链路需决策，其余为 UX 与服务端。

## ③ 分支现状（22 个远端分支，绝大多数是死的）

- `local/integration`：**ahead=0 / behind=41**，内容已全部在 main 上，只是没删。
- `claude/xingmang-site-naming-batches-xwms7a`：ahead=1 / behind=41。
- 另有 `feat/macos-support`、`xufei5620/claude-cloud/runbook-cleanup`、`claude/project-review-ma2wvr`、`claude/mac-platform-so8dlw`、`codex/*`、`peaker520/*`、`v0/*` 等历史分支。
- ⚠️ **2026-08-10 那版 HANDOFF 里「已核实可安全删除」的分支清单不要照抄**：今天复核，其中几条对 main 仍有 ahead 提交（不是 main 的祖先），与当时的结论对不上。**要删分支必须重新逐个核实，并由仓库所有者执行。**

## ④ 已知陈账

- **任务索引 #27 与 `docs/IMPROVEMENT-PLAN.md` 停在 8 月**，0.2.x 这五次发布的内容没有回写进去。
- **`docs/` 下多份计划文档描述的是中间态**（尤其 `ACCOUNT-PLAN.md` / `CANVAS-INTEGRATION-PLAN.md` 里 2026-08-12 之前的画布与账号描述），CLAUDE.md 第 9 节已就画布文档标注「2026-08-12 起执行搬进主进程，早于该日期的描述以代码为准」。
- **CHANGELOG 断档**：`CHANGELOG.md` 缺 0.1.13 ~ 0.2.5；其中 0.1.13 ~ 0.1.19 与 0.1.29 在两份日志里都没有条目（这两个版本确有发布提交），属历史遗留，不回补。
- 死分支从未清理（见③）。

## ⑤ 开工前必读顺序

1. `docs/ROADMAP.md` — 产品定位与优先级
2. `CLAUDE.md` — 不变量 I1-I15 / 陷阱 T1-T13，**保命的**
3. `docs/AGENT-RUNBOOK.md` — 怎么领任务、怎么提 PR
4. 按改动面补：改账号 → `docs/RECON-new-api.md`；改画布 → `docs/RECON-canvas.md` + `docs/CANVAS-V2-PLAN.md`；动界面 → `ui-spec/HANDOFF.md`

**提交前硬门槛**：`npm run typecheck` + `npm test`（Windows 已知环境失败见 #40，对比改动前后失败数，不要引入新失败）。
