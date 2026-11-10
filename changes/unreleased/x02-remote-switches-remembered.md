## 开发

- D83（深查 RC-06）：远程关功能、已知问题提示、充值方式开关这三样也记在电脑上（数据目录里的 `service-switches.json`，
  新模块 `electron/service-switches-store.ts`），读成功的那次再覆盖，一样都没写的那次记成空的。以前只活在内存里，
  读不到更新目录的电脑重开一次星芒，远程关掉的功能、藏掉的付款方式就回来了，「先这样绕过去」那句也没了。
  记的是没按版本、平台筛过的原样（`service-status.ts` 的 `pickServiceSwitches` / `parseServiceSwitches`），用的时候
  再按这一版、这种安装包筛；读回来用状态文件同一套解析器重新校验。开机时 `bootstrap/updates.ts` 在状态文件第一次读之前
  交给更新服务的新方法 `restoreServiceSwitches`（这次读成功过就不理），充值页在这次一次也没读成功过时用它。
  读不到状态文件的包（本地构建、开发态）不用这份记录。代价：撤掉开关以后一次也没读到过的电脑会一直关着。
