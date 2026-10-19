## 开发

- 撤回、分批放量、最低版本可以只管某几种安装包（#1155 第 5 条）：状态文件新增可选的 `badVersionPlatforms`、
  `rollout.platforms`、`minimumVersionPlatforms`，平台写成 `windows` / `mac` / `linux`，可接 `-x64` / `-arm64`
  （`electron/service-status.ts` 的 `resolveReleasePlatforms` / `resolveReleaseGuardFor` / `resolveMinimumVersionFor`，
  更新服务按这台电脑的平台和架构去对，Rosetta 上的 Intel 版 Mac 两种都算）。只撤某几种的版本照旧写在 `badVersions` 里，
  0.2.19 及以前的客户端不认新字段，照旧整版撤回、所有平台一起分批、所有平台都拦，只会更保守；平台表写错一律按对所有平台生效。
- `scripts/service-status.cjs` 认「0.2.20@mac-x64」「0.2.21 0@mac-x64」「0.2.21@mac-x64」这样的写法，写错的平台直接报错；
  已经对所有平台撤回的版本不能就地收窄，要先移出再加。带平台的最低版本仍按所有平台正在发的版本核。
  `release-guard.json` 一并记下撤哪几种，没有时文件跟以前逐字一样。工作流只改了三个输入的说明文字。Refs #1155。
