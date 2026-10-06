## 用户

- 在「设置 → 网络」换了连接线路并重启星芒以后，星芒替当前账号配好的 Claude Desktop、WorkBuddy、OpenCode 也会换到新线路，
  Key 和模型不变，改之前留备份。客户端开着时先不改，首页那一行写「连接线路暂未改动，完全退出后点「重新检测」」；自己手动改过的配置不动。
- 换线路以后 Codex 因为桌面端还开着迁不过去时，首页说的是「Codex 桌面端」，不再说成 Codex CLI；Mac 上会说明只关窗口不算，
  要按 Command + Q 完全退出，再点「重新同步」。

## 开发

- 第四十三批 A：外部客户端检测（`system-service.ts` 的 `scanExternalClients`）先过 `followExternalClientRoutes`。规矩照 #872 给
  四个命令行工具定的，四条都满足才写：用户明确选过线路并已重启生效（`relayRouting.selection`）、配置地址是这个站登记过的另一条线路、
  归属对得上当前账号（`externalOwnership.matches` 按旧地址核）、客户端装着且没开着（拉完模型清单、写之前再强制盘点一次）。写走保存
  配置那一条（`configureExternalTool` 拆出不排队的 `configureExternalToolNow`，多一个只给换线路用的 `beforeWrite`），Key、模型用
  配置里原来的，OpenCode 按原来的 npm 包带上协议（`external-tool-config.ts` 新增 `resolveOpenCodeProtocol`）。客户端开着就不写，
  状态带 `routePending`（`ExternalClientConnectionStatus` 新增可选字段），首页灰字在「运行中」后面接那句提示、不摆模型名。
- 选过线路的人连读配置也排进 `externalConfigQueue`，两次检测同时跑时后一次读得到前一次换完的那份。没选过线路、历史账号、手改过
  Key 或地址、别的账号写的，都不写、不发请求。换完归属记在新地址上，同一次运行里不会来回改；换完又回到旧那份（推测是客户端
  退出时写回）只记一次日志。日志 `external-client.route.followed / deferred / failed / reverted` 只记客户端和线路 id，不记地址和 Key。
- 第四十三批 C：`account-bootstrap.ts` 新增 `routeDeferredMessage`，换线路先不迁 Codex 时按 `inspectRunningTools` 的结果挑说法：
  Codex CLI 自己在跑或看不出来照旧；Mac 上只确定桌面端开着时说 Command + Q；其余只是桌面端开着时把工具名换成「Codex 桌面端」。
  什么时候先不迁一点没变。`keySyncFailureText` 让已经点了「Codex 桌面端」的原话不再被加上「Codex CLI：」。
- 测试：`external-client-service.test.ts` 加一组（换过去、换回来、开着不动且标 `routePending`、拉清单期间被打开不写、没选过线路 /
  别的账号 / 手改过 Key / 历史账号不动、拉不到模型或模型没了下次再试、写回旧配置不来回改）；`external-model.test.ts`、
  `account-bootstrap.test.ts`、`key-sync-failure.test.ts` 补对应用例。
