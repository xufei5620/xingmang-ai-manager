## 用户

- 技能多、记录多的电脑上，打开「技能」「记录」两页时整个窗口不再跟着卡一下。

## 开发

- 「技能」「记录」两页在主进程里的读盘改为异步：`codex-extensions.ts` 的 `listSkills`（连同 `importSkill` / `uninstallSkill` / `requireManagedSkill`）、`provider-extensions.ts` 的 Skill 目录扫描与 MCP 配置读取、`codex-plugin-catalog.ts` 的插件说明读取、`codex-sessions.ts` 列表里逐条的 rollout 文件检查、`provider-sessions.ts` 的目录可用性检查。读取结果、排序、错误处理不变；Codex 会话数据库仍是同步查询（`node:sqlite` 没有异步接口），只是查完就关、不跨 await 持有。
- 新增 `electron/async-map.ts` 的 `mapWithConcurrency`（按原顺序返回、同时最多 16 个）：几千个文件请求一次性发出会在同一轮里集中回调，照样卡住窗口。沙箱实测 2000 个技能时主进程最长一次卡顿从约 200 毫秒降到约 4～8 毫秒，2000 条 Codex 记录从约 90 毫秒降到约 13 毫秒；代价是后台读完的总耗时变长（30 个技能约 8→32 毫秒）。
