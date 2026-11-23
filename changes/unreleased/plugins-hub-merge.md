## 用户

- 精选、外接工具、技能和插件合并为「插件」页面，可一次安装到 Claude 和 GPT；技能现可直接从压缩包导入。

## 开发

- renderer-v2 新页 `features/extensions/PluginsHub.tsx`（`page-extensions`，侧栏一行「插件」接在第一组最后），照扩展合并方案第二版（yoyo 2026-11-20 回「改」）：
  左边窄栏（插件 / 技能 / 已安装），右边「推荐」「自己加的」，三家的外接工具、插件、技能按「种类 + 名字」合成一条；安装框、从所有工具里移除、技能导进几家都是一家一家调现有的
  `mcp:add` / `extensions:mutate` / `extensions:copy-mcp` / `skills:import`，没有新 IPC 通道。
- `registry/pages.ts` 加 `extensions` 页和 `extensionPageAliases`：`featured` / `mcp` / `skills` / `plugins` 四个旧 id 留作别名，跳过来落到新页对应那一栏。
- GPT 官方插件图标：`scripts/build-plugin-icons.mjs` 发版前按 openai/plugins 快照生成 96×96 PNG 进 `bundled-catalog/plugin-icons/`（带 sha256 索引，SVG 带脚本、外链的拒收）；
  Claude 官方按名字对上 `simple-icons`（`registry/plugin-icons.ts`）。新令牌 `--surface-logo-tile` 给图片图标垫白底。
