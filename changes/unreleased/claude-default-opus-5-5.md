## 用户

- 新配的 Claude Code 默认用 Opus 5.5；当前账号还没有 Opus 5.5 时照旧用 Opus 5。
- 已经在用 Opus 5 的，打开 Claude Code 前会问一次要不要换成 Opus 5.5，选「先不换」就不再问；自己选过别的型号的不受影响。

## 开发

- `cli-model-defaults.ts`：Claude 默认型号改为 `claude-opus-5-5`，分组里没有时先退回 `claude-opus-5`；新增 `resolveCliModelUpgrade`（上一代默认 → 这一代）。
- `tool-model-check.ts`：多一种 `upgrade` 结果，只在配置里还是上一代默认、账号已有新型号时给出；问过记进 `settings.json` 的 `offeredModelUpgrades`（只增不减，只有主进程写），记不下来就不问。打开前的提问复用 #520 的换型号对话框。
- 核对过 Claude Code 2.1.282 的包内代码：2.1.277 不认识 `claude-opus-5-5`；2.1.280 起顶层 `effortLevel` 只作用于老型号，Opus 5.5 用它自己的默认推理强度，而这个默认正好是 medium，所以不另写按型号的设置（第十五批 6）。
