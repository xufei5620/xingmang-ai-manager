---
paths:
  - "src/*.ts"
  - "src/*.tsx"
  - "src/components/**"
  - "src/pages/**"
  - "src/styles/**"
  - "src/styles.css"
  - "tooling/legacy-renderer/**"
---

# legacy 回滚版已冻结

> yoyo 2026-09-19 就审查总表 `R-S12`（legacy 去留三选一）拍板：**保留但冻结**（选项 b）。不定退役日期，也不重排 #30。
> 这是按路径加载的规则：只有改到 legacy 渲染层的文件时才进入上下文。摘要在 `CLAUDE.md` 第 5 节 T14。

你现在改的文件属于 **legacy 回滚版**。它作为 renderer-v2 出问题时的回滚手段保留，不再演进。

## 冻结范围

`src/` 下除 `src/renderer-v2/` 以外的全部源码 —— `App.tsx`、`components/`、`pages/`、`styles.css`、`styles/`、`src/*.ts` 纯逻辑层以及它们的 `.test.ts` / `.test.tsx` —— 加上 `tooling/legacy-renderer/`（隔离的 React 18 依赖）与 `npm run compile:legacy` / `npm run dev:legacy` 两条入口。

**不在冻结范围内**：主进程 `electron/`（`vitest.config.ts` 里那个叫 `legacy` 的 project 同时覆盖它，project 名字与本规则无关）、`src/renderer-v2/`、`canvas-v2/`、`e2e/`、`scripts/`。

## 只接受什么

**安全修复。** 也就是违反 `CLAUDE.md` 第 4 节 I1–I15 的问题：命令注入、跨提权边界的环境净化、API Key 或账号凭据跨 IPC、路径穿越、IPC 入参未校验、日志/诊断/导出未脱敏、导航与外链白名单。按原来的标准修，该写测试就写。

## 不接受什么

新功能、界面调整、文案优化、一般级与建议级缺陷、重构、补测试、为了和 renderer-v2 行为对齐而改 legacy。这些一律只在 `src/renderer-v2/` 做。审查清单里遇到 legacy 侧的同类条目，直接标「legacy 已冻结，不修」并说明 v2 侧是否有等价问题。

## 同时改两棵树

只有两种情况允许一个 PR 同时动 legacy 和 renderer-v2：

1. 安全修复在两侧都成立；
2. 跨树的类型或契约变更（改了 `electron/ipc-contract.ts` 之后两侧都得跟着编译通过）。

功能提交不许捎带 legacy。

## 不删代码、不改行为

冻结不是退役。`npm run compile:legacy` 与 `npm run dev:legacy` 保持可用，legacy 的既有 vitest 用例继续在 `npm test` 里跑，不许为省时间跳过或放宽断言。`vite.config.ts` 里那个「renderer-v2 不得导入 legacy UI」的模块图守卫照旧有效。

## 什么时候要回去问 yoyo

如果 legacy 连构建或启动都不成立（`R-F1` 那一类「回滚版事实上不可用」），那已经不是「修不修一个缺陷」，而是「冻结还有没有意义」——回到 yoyo 那里重新拍板，不要自己在 legacy 上做功能性修复来救它。
