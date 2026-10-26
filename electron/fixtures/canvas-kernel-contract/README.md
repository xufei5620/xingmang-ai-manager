# 画布新内核契约样例

画布换成 xingmang-canvas 内核（#1392～#1395）之前，桌面端先学会认新内核写的工程文件、发的运行请求和提示词预设。这里的三份样例就是新内核原样会写出、发出的东西，`electron/canvas-kernel-contract.test.ts` 拿它们过桌面端的解析器。

**以桌面端的解析器为准。** 新内核那边的 CI 也读这三份文件：桌面端收紧或放宽了什么，改这里的样例，两边谁偏了都会红。

| 文件 | 内容 | 测试怎么用 |
|---|---|---|
| `workflow-accepted.json` | 一份带齐六个新字段（`dirty`、`imageCandidateCount`、`videoCandidateCount`、`outputText`、`promptReferences`、`textWebSearch`）的工程，外加 4096 个点的蒙版、超过 1 万字且以链接开头的便签、160 字的提示词引用名 | 必须能保存、能重新打开，内容一字不差 |
| `run-graphs.json` | 新内核发来的运行请求，每条写明结果：`refusal: null` 照常运行，`refusal: "…"` 在付费请求之前拒绝并报这句话，`parseError: "…"` 解析时就拒绝 | 逐条解析，再算运行范围里第一个桌面做不了的原因 |
| `prompt-presets.json` | 160 字的预设名能存，161 字报错 | 过预设解析器 |

**带 undefined 的键。** 新内核拼运行请求时，没设的可选项也会写成值为 `undefined` 的键，跨进程的结构化克隆会把这种键原样带过来，JSON 却存不下。所以 `run-graphs.json` 顶上列了这些键（`kernelUndefinedKeys`），测试先把它们补回每个节点，再用 `structuredClone` 模拟一次跨进程，然后才解析。新内核那边用这份样例时也要这样补。

**怎么改。** 别手改 JSON，改 `generate-fixtures.mjs` 里的用例再重新生成：

```bash
node electron/fixtures/canvas-kernel-contract/generate-fixtures.mjs
```

这些文件只给测试用，不进安装包。
