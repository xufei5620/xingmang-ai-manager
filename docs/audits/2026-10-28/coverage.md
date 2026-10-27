# 全量文件台账与实际审查深度

固定基线 `c21be2741af6674b2f422d9891b57fc3d2ba5b7b` 共 **2,383 个 Git 跟踪文件**、**607,957 行文本**。文件数包括生产代码、测试、文档、依赖锁、设计原型与资源；不包含 node_modules、编译产物和客户数据。最新增量单列于 [latest-delta.md](latest-delta.md)。

**这是全量清单对账，不是本轮对全部 607,957 行重新逐行人工通读的声明。** 已阅读的旧代码按哈希一致复用；新增和变化的生产路径补读；大量测试只核对结构和关键断言，文档/原型/二进制有明确浅层覆盖。执行测试也不等于每个运行分支被证明正确。

## 九个范围均无缺失、重复或哈希不符

| 范围 | 文件 | 行数 | 逐文件记录 |
|---|---:|---:|---|
| accounts_routes | 102 | 38,530 | [清单](coverage/accounts_routes.md) |
| canvas_ai | 278 | 59,884 | [清单](coverage/canvas_ai.md) |
| core | 378 | 127,194 | [清单](coverage/core.md) |
| install_clients | 147 | 58,723 | [清单](coverage/install_clients.md) |
| legacy | 187 | 41,207 | [清单](coverage/legacy.md) |
| platform_network | 154 | 45,207 | [清单](coverage/platform_network.md) |
| release | 312 | 94,844 | [清单](coverage/release.md) |
| renderer | 473 | 91,521 | [清单](coverage/renderer.md) |
| root_docs | 352 | 50,847 | [清单](coverage/root_docs.md) |

## 方式和数量

| 记录方式 | 文件数 |
|---|---:|
| `asset-inventory` | 11 |
| `binary-identity` | 1 |
| `delta-plus-reuse` | 1 |
| `documentation-targeted` | 81 |
| `fresh-full` | 90 |
| `fresh-generated-data` | 2 |
| `fresh-structured` | 1 |
| `fresh-targeted` | 10 |
| `fresh-targeted-support` | 174 |
| `fresh-targeted-test` | 117 |
| `fresh-targeted-tests` | 171 |
| `fresh_full` | 10 |
| `fresh_support_test_review` | 55 |
| `full` | 4 |
| `full-current` | 41 |
| `history-index` | 100 |
| `identity-and-reference` | 2 |
| `reference-index` | 132 |
| `reuse-full` | 865 |
| `reuse-full+fresh-diff` | 8 |
| `reuse-full-plus-delta` | 6 |
| `reuse-full-plus-diff` | 2 |
| `reuse-text-identical` | 5 |
| `reuse_full` | 172 |
| `structured-data` | 3 |
| `targeted` | 48 |
| `targeted-behavior` | 8 |
| `targeted-structure` | 154 |
| `test-index` | 42 |
| `test-structure` | 67 |

- `fresh-full` / `fresh_full` / `full` / `full-current`：本轮全文读取；仍须看专项说明是否有运行验证。
- `reuse-full` / `reuse_full`：旧全文阅读记录与当前字节一致，本轮另复读关键根因，不冒称重新全文读取。
- 包含 `delta` / `diff` 的记录：旧全文证据加完整变化复核；`reuse-text-identical` 仅换行不同而文本一致。
- 含 `targeted` / `test-index` / `test-structure` / `support`：按文件核对用例、门控、局部正文或断言，**并非完整测试源码逐行审阅**。
- `structured` / `generated-data`：解析、来源、生成一致性或摘要核验，不把大数组/重复文本说成人工逐字检查。
- `documentation` / `history-index` / `reference-index` / `identity-and-reference`：资料结构、关键约束、用途或来源核对；历史声明不自动成为当前事实。
- `asset-inventory` / `binary-identity`：字节身份与格式/用途核对，没有逐像素或二进制逆向审查。

复核脚本核对了原始 inventory、每个专项账本和工作树字节三方一致；2383个路径恰好覆盖一次。JSON与完整复现脚本留在本地受控材料，此公开Markdown台账可用于定位每个文件的实际深度。它不承诺零遗漏缺陷；未做原生平台操作、全外部依赖CVE扫描和生产模型调用。
