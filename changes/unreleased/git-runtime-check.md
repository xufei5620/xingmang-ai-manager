## 用户

- 「检查」页和首页的运行环境里多了一项「Git」：Windows 上没装 Git 时会说清楚会怎样（Claude Code 会退回 PowerShell，技能和插件里写的命令可能失败，第一次装官方插件市场也需要它），并给出下载入口；macOS 提示用 xcode-select 或 Homebrew 装。装完 Claude Code 后如果这台电脑没有 Git，第一条命令那张卡下面也会补一句提示。Git 不是必装项，缺了不会把运行环境整体判成不通过，也不会替你安装。

## 开发

- 候选 4：新增零依赖的 `electron/git-runtime.ts`，把「缺 Git 会怎样 / 怎么装」的分平台中文文案收成唯一来源，`provider-extensions.ts` 的插件市场缺 Git 提示（#277）改为复用它，避免两处各写一份。PowerShell 退回那句只在 Windows 成立，macOS 不照抄。
- `system-service.ts` 的 `scanSystem` 增加 `inspectGit()`（版本号只保留数字段），`SystemSnapshot.runtime` 加 `git: ToolStatus`；探测失败按 A4 走 `buildToolStatusFromSettled` 归成「检测失败」，与「未安装」区分，且不连累 node/npm 探测。
- `diagnostics.ts` 增加 `RUNTIME_GIT` 检查项，缺失记 `warn`（Git 官方文档明说 optional）而非 `fail`，摘要用共用文案。
- 渲染层：首页运行环境卡（`features/tools/Home.tsx`）渲染 Git 行，缺失时给中文提示，Windows 额外给「下载 Git」按钮（落点 `git-scm.com/download/win`，已并入 `main.ts` 外链白名单 I12）；`FirstRun.tsx` 增加可选 `gitHint`，仅 Claude Code 且缺 Git 时显示；教程「开始使用」章补一句 Git 的作用。`ui/brand.tsx` 的运行环境图标表加入 Git。
