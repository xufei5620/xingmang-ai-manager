# V2 旧 testId 缺失清单

由 TypeScript AST 生成。缺失表示旧模式未在新版出现；不等同功能缺失。泛型透传与不可解析表达式不会自动算作覆盖。存在固定前缀动态模板的项目独立列为候选，需结合运行时检查。

| 未匹配旧模式 | 类型 | 首个旧位置 |
|---|---|---|

| 有动态匹配候选的旧模式 | 新模板 | 新位置 |
|---|---|---|
| guide-route-claude | guide-route-${item.id} | src/renderer-v2/features/auth/StartGuide.tsx:115 |
| guide-route-codex | guide-route-${item.id} | src/renderer-v2/features/auth/StartGuide.tsx:115 |
| guide-route-codexDesktop | guide-route-${item.id} | src/renderer-v2/features/auth/StartGuide.tsx:115 |
| guide-route-gemini | guide-route-${item.id} | src/renderer-v2/features/auth/StartGuide.tsx:115 |
| guide-route-grok | guide-route-${item.id} | src/renderer-v2/features/auth/StartGuide.tsx:115 |
