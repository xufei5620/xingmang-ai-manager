## 开发

- 升级冒烟、卸载冒烟挪进 `quality`（CI-6）：两个工作流去掉自己的 `pull_request` 触发、改成 `workflow_call`，由 `quality.yml`
  的 `upgrade-smoke`、`uninstall-smoke` 两个作业调用；跑不跑看 `scripts/ci-change-scope.cjs` 新出的 `upgradeSmoke`、
  `uninstallSmoke`（名单就是原来两个工作流的 `paths`，只在 PR 上跑），`quality-gate` 要求该跑的必须绿、不该跑的必须是跳过。
  以前 #1524 合并时升级冒烟红着，因为 `quality-gate` 看不见它。卸载冒烟的并发组改名，免得和调用它的 `quality` 撞组互相取消。
- 新增 `docs/RELIABILITY-CHECKLIST.md`（17 条，每条：从改动看得出的触发条件、查什么、出自哪次事故）和 `npm run checklist`
  （`scripts/reliability-checklist.cjs`）：按本分支对 `origin/main` 的改动列出命中的条目，清单从 `origin/main` 读，不读本分支那份。
  `scripts/reliability-checklist.test.cjs` 核对每条的写法、每个文件写法都还对得上仓库里的文件、每条都能被它出自的那次改动触发。
  PR 模板加「可靠性清单」一节。
- 新增 `docs/CI-RERUN-LEDGER.md` 和 `npm run ci:rerun-ledger`（yoyo 11-17 定「记账」）：重跑才过的都记一行，同一条两周内第二次
  「处理」必须以「查根因：」开头，`scripts/ci-rerun-ledger.test.cjs` 逐行核对；不删测试。补记了 10-31 到 11-11 的六笔。
- `AGENTS.md` 第 8 节加三条：同一个检查连修三轮还红就停手交回；提 PR 前跑 `npm run checklist`；CI 红了先查账再决定能不能重跑。
