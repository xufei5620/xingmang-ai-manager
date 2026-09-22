## 用户

- 不再往 Codex 的配置文件里写它新版已经不认的三项设置，启动时那句「忽略了若干项无法识别的配置」
  不会再出现；老配置里由本软件写下的同样三项，在下次保存配置或切换账号时自动清掉。

## 开发

- `electron/config-files.ts`：Codex 中转模板去掉 `disable_response_storage`、`network_access`、
  `windows_wsl_setup_acknowledged` 三个顶层键。用 0.155.1 的二进制核对过：前两者在当前版本里
  一处都搜不到、功能连同键一起被删且无替代；`network_access` 只作为 `[sandbox_workspace_write]`
  的布尔字段存在，顶层那行从来没生效过（`codex doctor` 显示 `restricted network`，写成嵌套的
  `true` 才变 `enabled network`），所以只删不搬——搬过去等于替用户放开沙箱联网。
- 新增 `dropDeprecatedCodexConfigKeys`，在 `applyCodexRelayConfig`（合并写入）与
  `stripCodexRelayFromConfig`（切回官方账号）两条路径上清掉这三个键，且只清值与当年模板一致的
  那一份；用户改过值的、以及嵌套表里的 `sandbox_workspace_write.network_access` 都不动。用户
  自己的官方配置快照仍按原文保存，切回官方时原样还回去。
- `scripts/probe-cli-relay.cjs` 的 Codex 探测配置同步去掉 `disable_response_storage`，保持与
  客户装到的那一份同形。
