---
name: 开发任务
about: 由规划方创建、分发给某个 agent 执行的任务
title: '[batch:N] '
labels: ''
assignees: ''
---

## 目标

<!-- 一句话说清要达成什么 -->

## 背景与现状

<!-- 为什么要做这件事。相关代码位置（文件:行号）、已知的问题表现 -->

## 做法建议

<!-- 具体改哪里、怎么改。不确定的地方明确标出，留给执行方判断 -->

## 验收标准

- [ ]
- [ ] `npm run typecheck` 通过
- [ ] `npm test` 无新增失败

## 约束

<!-- 明确不能做什么。参考 CLAUDE.md 第 8 节 -->

## 执行环境要求

<!-- 勾选。见 docs/COLLABORATION.md 第 5 节 -->

- [ ] 必须 Windows（提权 / PowerShell / 注册表 / Appx / 真实安装流程）
- [ ] 必须 macOS
- [ ] 任意平台（纯函数 / 类型 / 脚本 / 文档 / CI）

## 冲突风险

<!-- 勾选后请同时打上 serial-only 标签 -->

- [ ] 涉及 IPC 通道增删（`ipc-contract.ts` / `ipc.ts` / `preload.ts`）→ **serial-only**
- [ ] 涉及 `src/styles.css` → **serial-only**
- [ ] 涉及 `system-service.ts` / `App.tsx` 的结构性改动 → **serial-only**
- [ ] 无热点文件冲突，可并行
