## 用户

- 每天第一次打开工具时，会顺手核对一下当前账号能用哪些模型：Claude Code 里的模型菜单悄悄更新成最新的；工具里设的默认模型如果当前账号已经用不了，打开前会问一句要不要换成推荐的，点了才换，选「照旧打开」就不动。核对不成（比如断网）也照常打开。

## 开发

- 新增 `electron/tool-model-check.ts`（按工具与「站点 + 账号 + Key + 型号」缓存一天，失败一小时后再试，模型接口最多等 5 秒）与通道 `tools:check-models`；只核本软件用当前账号写的配置，Claude Code 菜单过期（`claude-model-picker.ts` 的 `claudeRelayModelPickerOutdated`）时走 `saveConfig` 的自动写入闸刷新。renderer-v2 在 `launch()` 里、选目录之前调用，换模型走空 Key + merge 的 `saveConfig`，配置来源保持不变。
