## 用户

- 如果发出去的新版本有严重问题，软件会提示「这个版本有已知问题」，并建议装回上一个稳定版本；还没升级的电脑不会再收到这个版本。

## 开发

- issue #28 客户端部分：`service-status.json` 新增 `badVersions`（撤回名单）与 `rollout`（分批放量）。`electron/updater.ts` 每次检查前重读状态文件，经 electron-updater 的 `isUserWithinRollout` 钩子拦下撤回版本、按放量比例只放一部分自动检查（手动检查不拦），只有本机版本被撤回时才开 `allowDowngrade`；已找到或下载好的版本被撤回会收回提议。快照新增 `currentVersionWithdrawn` / `rollback`，更新页与首页气泡改说「建议退回」。
- `publish-release` 覆盖清单前把线上那份按版本号备份到 `manifests/<版本>/`，新清单也存一份；新增 `rollback-release` 工作流（核对备份与安装包 → 撤回线上版本 → 换回备份清单 → 复核更新源）。`service-status` 工作流加撤回名单与放量两个输入。步骤见 `docs/SERVICE-STATUS.md`。
