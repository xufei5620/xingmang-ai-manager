<!-- 第一行写哪边做的：云端做的 / Claude-mac 做的 / Codex 做的 / yoyo 自己做的。标题用中文，一句大白话说清改了什么 -->

## Before

<!-- 改之前客户（或开发者）看到什么、哪里不对。一段大白话 -->

## After

<!-- 改之后看到什么。一段大白话 -->

<!-- 下面一句话说明：为什么这么改，或者有什么要特别留意的 -->

## How

<!-- 改了哪些文件、关键做法。修 GitHub issue 写 Fixes #N（只修一部分写 Refs #N）；修审查总表里的问题写上编号（E-/R-/P-/T-/M-/G-） -->

Fixes #

## 自查

<!-- 四道都跑，每道结尾的汇总行原样贴在下面。Windows / macOS 专有的部分以本 PR 上 quality 工作流对应平台作业的结果为准 -->

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run check:v2`
- [ ] `npm run test:v2`
- [ ] 带了 `changes/unreleased/` 分片（纯 CI、脚本、文档改动可以不带）

## 检查项

- [ ] 已阅读 `AGENTS.md` 的关键不变量与改动陷阱
- [ ] 未引入 `as any` / `@ts-ignore` / `eslint-disable`
- [ ] 面向用户的错误消息是中文，测试名是英文
- [ ] 若涉及安全边界（提权、路径信任、命令执行、网络请求）：已在测试中说明为什么安全
