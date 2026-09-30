## 用户

- 骁龙这类 ARM 芯片的 Windows 笔记本上，星芒替你装 Node.js 时会装 ARM 版，之后装的 Claude Code、Codex、Gemini 跑起来更快、更省电；本机已经有 Node.js 的不动。「检查」页多一项「电脑芯片」，说清这台电脑是 ARM 芯片、Node.js 是哪一版。

## 开发

- 新增 `electron/windows-processor.ts`：经 System32 的 reg.exe 异步读机器级 `PROCESSOR_ARCHITECTURE` 与 CPU Identifier 认出真实芯片（x64 星芒在 ARM64 上被模拟，`process.arch` 报 x64），读 node.exe 的 PE 头判断现有 Node.js 是哪一版。
- 装 Node.js 时本机没有 Node 才按真实芯片挑包，已有 Node（版本旧要换）跟它保持同一版，避免 x64 / arm64 两份 MSI 混装；认准芯片时 winget 追加 `--architecture`。
- 诊断新增 `WINDOWS_ARM`（只在 ARM 电脑出现，只做说明）。第十七批候选第 5 条第一步；ARM 安装包（第二步）未做。
