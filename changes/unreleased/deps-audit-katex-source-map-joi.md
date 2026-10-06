## 开发

- 2026-10-06 新出的三条依赖公告让 quality 的 `audit`（`npm run audit:ci`）在 main 179cdfe 上报红，所有 PR 都卡在 quality-gate。
  锁文件把 source-map-js 从 1.2.1 升到 1.2.2（GHSA-68fv-2mgg-jv7q，vite → postcss 带进来）、joi 从 18.2.8 升到 18.2.9
  （GHSA-wr44-6hxh-3jwq，wait-on 带进来），两处都在原来声明的范围内，`package.json` 不动。
- katex 从 0.16.47 升到 0.19.0（GHSA-238p-pmpm-9mq7，修在 0.18.2）。它是 AI 聊天显示公式用的（`features/chat/math.ts`），
  会打进渲染层。npm audit 连带报的另外 5 条（@lobehub/ui、mermaid、rehype-katex、remark-math、micromark-extension-math）
  都是 @lobehub/icons 的 peer 依赖 @lobehub/ui 带进来的，各自最新版仍只认 katex 0.16.x（mermaid 12.1.0 要 `^0.16.47`、
  micromark-extension-math 3.1.0 要 `^0.16.0`），升不出修好的版本，所以 `overrides` 加 `"katex": "$katex"`，整棵树只留一份 0.19.0。
  这几个包本仓源码一个也没 import（只从 @lobehub/icons 引单个图标组件），渲染层打包产物里没有 mermaid。没加白名单，
  `scripts/audit-development-dependencies.cjs` 没改。
- katex 0.17～0.19 的不兼容改动（内部 `__defineFunction`、HTML 输出的 CSS 类名加前缀、缺字形改走 `strict`）碰不到这里的用法：
  只要 MathML、`strict: 'ignore'`、样式只认 `.chat-math math`。46 条常见公式（含中文、emoji、矩阵、对齐、`\href`、`\htmlClass`）
  两版输出对比，43 条逐字节相同，另外 3 条是新版多认得 `\reflectbox`、`\mapsfrom` 和 gather 环境末行不再丢。
- katex 0.19.0 自带的 commander 从 8 升到 15，要求 Node 22.12 以上；只有 katex 的命令行用它，CI 用的 Node 22 满足。
