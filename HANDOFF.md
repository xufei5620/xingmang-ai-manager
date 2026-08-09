# 交接说明 HANDOFF（2026-08-10）

> 给接手本仓的云端 AI agent。本地会话因周限接近，把工作推到 GitHub 由你接力。
> **动手前先按顺序读**：`CLAUDE.md`（不变量 I1–I14 + 改动陷阱 T1–T11，保命）、`docs/AGENT-RUNBOOK.md`（怎么干活/提 PR）、`docs/ROADMAP.md`（产品背景）。本文件只讲「当前到哪了、接下来做什么」。

## 当前状态
- 分支 `local/integration`，HEAD = 本文件所在提交（其父 `f4b3ef3` 是账号体系 + 打磨的最后一个代码提交）。工作树干净。
- **门槛全绿**：`npm run typecheck`（三段 tsconfig）0 错；`npm test` = vitest **1297 passed / 0 failed / 158 skipped**（Windows 平台门控跳过）+ node --test **79 passed**。Windows 可能有 **#40** 环境相关已知失败（符号链接权限 / Defender 超时），对比失败数、别引入新的。
- **铁律**：自动化测试**绝不触生产 `xm.solov.cc`**（全部 mock）。提交风格：中文 conventional + 结尾 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。**不要改 `CLAUDE.md`**。加 IPC 通道必须串行（T1：键顺序=注册顺序，`ipc.test.ts` 顺序断言必须绿）。

## 本轮已完成：账号体系五波 + 打磨
账号后端是 QuantumNous/new-api（生产实例 `xm.solov.cc`，实测已升 **v1.0.0-rc.24**）。

| 内容 | 提交 |
|---|---|
| W2/W2.5 登录持久化（safeStorage 加密 session）+ token 自动续期 + 新用户衔接（任务卡一键写 Key） | `3a4b1fa` |
| W3 找回密码（邮件重置，服务端生成新密码） | `f9cf547` |
| W4a 个人中心只读面：资料/用量/邀请/充值（appView `account-center`，账号区头像进） | `f4a6a9b` |
| W4b 个人中心写操作面：Key 管理（列表掩码元数据+撤销确认）/ 修改密码（需原密码，改后本设备免重登）/ 侧边栏充值联动 wallet | `3bc2b1a` |
| #23 Grok darwin 安装回滚清理 agent 链悬垂 | `53883bd` |
| #24/#27 欢迎页/导航 UI 无障碍与竞态 nit | `1795794` |
| #26 refresh cookie 值并入 I13 脱敏 secrets | `f4b3ef3` |
| RECON 文档更正生产已升 rc.24 | `2332dda` |

**关键源码事实（已从 new-api rc.24 tag 逐行核实）**：`GET /api/user/self`（buildSelfUserData 不返 access_token/密码/PAT）、`GET /api/log/self`（分页 `p`/`page_size` clamp≤100）、`GET /api/token/`（列表返回**掩码** key）、`PUT /api/user/self`（改密码需 `original_password`，改后本设备会话原地续 token、踢其他设备）、QuotaPerUnit=**500000**、充值页 `/wallet`、邀请参数 `?aff=`。详见 `docs/RECON-new-api.md`、`docs/ACCOUNT-PLAN.md`。

## 需真机验证（本地/云端自动化都测不了的）
1. **账号全流程**：注册 → 登录 → 个人中心（资料/用量/邀请/充值/Key 管理/改密码）→ 找回密码（收邮件）。
2. **W4b Key 管理表 7 列 grid 列宽是手工估算** —— 真机看是否一屏不溢出（用户硬约束：每页一屏、不下拉）。
3. 改密码的 i18n 文案匹配（「原密码错误」/「账号未设密码」）基于 rc.24 yaml 直读、未真机触发过。

## 接下来做什么（未做，按优先级）
1. **画布集成**（大工程，原定「先账号后画布」，账号已完成、可开工）：见 `docs/CANVAS-INTEGRATION-PLAN.md`。已定决策：**移除画布插件系统**（只留内置节点、静态打包）、**保留画布原生外观**、**弱化但保留版权声明**。
2. 遗留小项（下列 # 号是本地会话的任务编号，云端无此任务板，仅供检索语境）：
   - **无 `info`-toast 变体**：`src/components/Toast.tsx` 的 `ToastMessage.type` 只有 `'success' | 'error'`，全仓无 `info`。若要让 welcome 占位类动作的 toast 用中性语气，需先给 type 加第三态 + `styles.css` 加 `.toast.info` 规则（小功能，非缺陷）。
   - #25 给 welcome 独立 `AppWindowMode`（要动 `electron/`，现复用 dashboard 几何、功能正确）。
   - #29 `npm run dev` 竞态：`wait-on` 应等 tsc 首次编译完再启 electron（现有 `npm start` 可绕过）。
   - #28 画布 `schemaVersion` 升 v2 时改显式 `?? 1`（在**画布仓库**，不在本仓）。

## 提 PR / 协作
本地会话此前一直 **0 push、仅本地 commit**；本次因用户明确要求推 GitHub 供你接力。你继续时按 `docs/COLLABORATION.md` 的分支/PR 规范，改动前确认对应 Issue（任务索引在 GitHub **Issue #27**）。
