## 开发

- 新增 `npm run selfcheck`（`scripts/self-check.cjs`）：把提 PR 前的四道自查（typecheck、test、check:v2、test:v2）按 PR 模板的顺序一条命令跑完，哪道红了也接着跑后面的，结尾打印一段原样贴进 PR 的汇总；云端容器里 Playwright 自己那份 Chromium 不在时，替这一次运行设上 `XINGMANG_E2E_CHROMIUM`；依赖或 Electron 没装时一道都不跑，把该敲的两条命令打出来。四道本身没改。
- 新增 `docs/CLOUD-SANDBOX.md`：云端容器里怎么装依赖、浏览器套件怎么跑、哪些网站连不上、CI 怎么看，这些以前只记在云端项目的记忆里，2026-11-11 重新核过后搬进仓库。
- `AGENTS.md` 开发流程加两条：修缺陷先写一条在旧代码上会红的用例；下一个人也会踩的坑随 PR 写回仓库文档（`docs/COLLABORATION.md` §7.4，含每月整理一次云端记忆）。
- 等 yoyo 点头的界面改动，动了版面的要配一张改完的截图（`docs/COLLABORATION.md` §7.5、`.claude/rules/renderer-v2.md`）；新增 `scripts/audit/v2-page-screenshot.mjs`，在本地夹具上几秒截一张。
