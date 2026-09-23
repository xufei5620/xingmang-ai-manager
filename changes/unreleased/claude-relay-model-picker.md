## 用户

- 用当前账号跑 Claude Code 时，`/model` 选模型菜单只列当前账号实际能用的型号，不会再选到用不了的型号，也不再显示官方价格。

## 开发

- 新增 `electron/claude-model-picker.ts`：保存 Claude 配置时，按当前 Key 的可用模型生成 `modelPicker`（`replaceBuiltInOptions: true`，只取 `claude-` 开头的型号，最多 20 个且必含当前型号，标签如 Opus 5 / Sonnet 4.6，说明是完整 id），并写 `env.ANTHROPIC_DEFAULT_MODEL` 让菜单里的 Default 指向选定型号。用户自己写的菜单不动；一个 Claude 型号都没有时保留官方菜单；切回官方账号时收回。`saveProviderConfig` 多一个可选参数 `availableModels`，由 `system-service.ts` 的 `saveConfig` 传入已拉到的模型清单。沙箱实测 2.1.277 菜单与请求型号都对。对应「接中转后的官方体验差距」C2。
