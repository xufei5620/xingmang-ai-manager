## 用户

- 在「设置 → 网络」换了连接线路并重启星芒以后，星芒替当前账号配好的 Claude Desktop、WorkBuddy、OpenCode 也会换到新线路：
  只改连接地址，Key、模型和你在客户端里改过的设置都不变，改之前留备份。客户端开着时先不改，首页那一行写「连接线路暂未改动，
  完全退出后点「重新检测」」；自己手动改过的配置不动。
- 换线路以后 Codex 因为桌面端还开着迁不过去时，首页说的是「Codex 桌面端」，不再说成 Codex CLI；Mac 上会说明只关窗口不算，
  要按 Command + Q 完全退出，再点「重新同步」。

## 开发

- 第四十三批 A：外部客户端检测（`system-service.ts` 的 `scanExternalClients`）先过 `followExternalClientRoutes`。规矩照 #872 给
  四个命令行工具定的，四条都满足才写：用户明确选过线路并已重启生效（`relayRouting.selection`）、配置地址是这个站登记过的另一条线路、
  归属对得上当前账号（`externalOwnership.matches` 按旧地址核；Claude Desktop 还要正在用的就是星芒标记的那一份，`inspectRouteCredential`）、
  客户端装着且没开着。先在新线路上查一次模型清单，Key 认、型号还在才换；查完、动文件之前再强制盘点一次，拉清单那几秒里被打开的不写。
- 只换地址，不走保存配置那一条：保存会把 Claude Desktop 的型号收成一个、认证方式改回 bearer，WorkBuddy 也只更新选中的那一条。
  新加 `external-tool-config.ts` 的 `followExternalToolRoute`（WorkBuddy 把地址在旧线路、Key 是这一把的每一条的 `url` 换掉；OpenCode
  换星芒那段 provider 的 `baseURL`，所选型号自己覆盖的那一处在旧线路上也换，npm 包和型号不碰）和 `claude-desktop-config.ts` 的
  `followRoute`（只改 `inferenceGatewayBaseUrl`）。两边都在写之前重读、再认一遍，对不上就一个字不写；原子写入、备份、快照比对照旧。
  换完不再另发连接自检：新线路上那次模型清单已经证明这把 Key 能用。
- 客户端开着就不写，状态带 `routePending`（`ExternalClientConnectionStatus` 新增可选字段），首页灰字在「运行中」后面接那句提示、
  不摆模型名。选过线路的人连读配置也排进 `externalConfigQueue`，两次检测同时跑时后一次读得到前一次换完的那份。没选过线路、历史账号、
  手改过 Key 或地址、别的账号写的、客户在 Claude Desktop 里复制出来的那份，都不写、不发请求。换完归属记在新地址上，不会来回改；
  换完又回到旧那份（推测是客户端退出时写回）只记一次日志。日志 `external-client.route.followed / deferred / failed / reverted`
  只记客户端和线路 id，不记地址和 Key。
- 第四十三批 C：`account-bootstrap.ts` 新增 `routeDeferredMessage`，换线路先不迁 Codex 时按 `inspectRunningTools` 的结果挑说法：
  Codex CLI 自己在跑或看不出来照旧；Mac 上只确定桌面端开着时说 Command + Q；其余只是桌面端开着时把工具名换成「Codex 桌面端」。
  什么时候先不迁一点没变。`keySyncFailureText` 让已经点了「Codex 桌面端」的原话不再被加上「Codex CLI：」。
- 测试：`external-client-service.test.ts` 加一组（换过去、换回来、开着不动且标 `routePending`、拉清单那几秒里被打开或被客户改了都不写、
  客户在客户端里加的型号 / 认证方式 / 注释 / 别家条目原样留着、复制出来的 Claude Desktop 配置不认、没选过线路 / 别的账号 / 手改过 Key /
  历史账号不动、拉不到模型或模型没了下次再试、写回旧配置不来回改）；`external-tool-config.test.ts`、`claude-desktop-config.test.ts`
  补只换地址的单测；`external-model.test.ts`、`account-bootstrap.test.ts`、`key-sync-failure.test.ts` 补对应用例。
