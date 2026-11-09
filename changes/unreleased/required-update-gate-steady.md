## 用户

- 被要求先更新的那层提示不会再忽隐忽现：下载新版本时网络慢了一下，提示不会自己收起；提示真收起了，下好也不会突然重启。装更新前如果还有工具在装，会先问你一句，可以先让它装完。

## 开发

- 强制更新那层提示（`RequiredUpdateGate`）一次没读到状态文件就整层收起，客户先前点过的「立即更新」照样在下好时直接退出重启装，也不问有没有工具在装（0.2.24 深查 远程配置 RC-01）。三处改动：
  - `electron/updater.ts` 的 `applyServiceStatus`：状态文件读不到（`status` 为 null）时最低版本沿用这次运行里读成功的那份，只有读到了、文件里确实撤掉了才放人；仍不记到本地，重开软件还读不到的电脑不拦（`docs/SERVICE-STATUS.md` 同步改）。维护提示照旧跟着这一次走。
  - `required-update.ts` 的 `requiredUpdateFollowUp`：那层提示不在时不替客户接着下载、接着装；`RequiredUpdateGate` 在提示收起时把先前那一下「立即更新」作废，再盖回来要他自己再点。
  - 门里的「立即更新」改走 `installUpdate({ askIfInstalling: true })`：还有工具在装时主进程先问退出时那一句（已知31，沿用原有的字），点「继续安装」这次不装，按钮回到「立即更新」。
- `updater.test.ts` 补「下载中读超时提示不收起」「重开软件不带上次的最低版本」，改了「读不到就放人」那条断言；`required-update.test.ts`、`app-check.mjs` 补提示收起后不替客户装、门里装之前带 `askIfInstalling`、点了「继续安装」按钮回到可点。
