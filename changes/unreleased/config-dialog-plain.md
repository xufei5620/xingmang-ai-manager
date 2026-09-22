## 用户

- 工具配置窗口点「保存配置」就直接保存，不再弹出「仅更新」和「重置」让你二选一；你在工具里做的其他设置照样保留，改之前也照样自动备份。很少用到的「重置为初始状态」和密钥详情收进了窗口底部的「高级」。
- 选了「自动准备」密钥时，新的「保存并检测模型」按钮一步完成保存和列出模型，不用再关窗、重开、再检测。
- 窗口里的说明换成了大白话：「专属分组」「Responses 接口」这类词不再出现；「非 GPT 模型」改叫「别家模型」，「已有第三方配置」改叫「用的是别处的配置」。

## 开发

- `features/tools/ConfigDialog.tsx`：删掉保存前的「保存这份配置？」对话框，`保存配置` 直接走 `save('merge')`；重置按钮（`tool-save-reset`）移进新的 `<details data-testid="tool-config-advanced">`，仍经 `Confirm` 二次确认，取消直接回到配置窗口。保存与重置共用 `readyToSave()` 前置检查。两条路都仍由主进程先备份再两阶段写入（I9），IPC 与写入参数不变。`tool-save-merge` 随对话框一起消失。
- 新增「保存并检测模型」（`tool-save-detect-models`）：自动准备密钥时 `configureManaged(tab, model, 'merge')` → `onRefresh()` → `readConfig()` 取主进程实际写入的模型 → `configuredModels(tab)`，留在对话框里；草稿标为未改动，关窗不再问「放弃修改」。
- 下拉框与摘要不再写「分组未确认」（`key-selection.ts` 只在认得出时带分组名），分组只在「高级」的保存摘要里出现。配置来源判定顺序（`sourceFor` / `tool-config-ownership.ts`）没动。
- 文案：`model-filter.ts` 的五条提示、首页工具菜单「换用别家模型」、`registry/status.ts` 的 `unknownSource`、`StartGuide.tsx`、`account-switch-sync.ts`，以及教程里提到「仅更新账号来源、密钥和模型」的章节与插图。外部客户端（Claude Desktop 第三方推理）那条「已有第三方配置」是另一回事，没改。
- 浏览器回归：`app-check.mjs` 把「选保存方式」相关用例改成「高级里重置、取消不写入」，merge / reset 的并发保护拆成两条，新增「保存并检测」一条（钉住只调一次 `configureManagedCliKeys`、采用实际保存的模型、关窗不追问）。
