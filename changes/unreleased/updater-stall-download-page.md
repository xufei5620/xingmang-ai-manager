## 用户

- 下载软件更新一直停住、自动换条路重下也还是停住时，更新页和窗口右下角的「下载更新失败」提示里，「重新下载」旁边
  多了「打开下载页」，可以去下载页下新版本的安装包手动装。自动换条路重下的那一次也多等一会儿才算停住：有的公司网络
  会先把整个安装包扣下查一遍再放行，这样更容易下完。

## 开发

- 0.2.15 发版前回归检查第二节⑤：#793 的看门狗 45 秒没有新数据就掐断、换直连重下一次整个安装包，再停住就报
  `UPDATE_DOWNLOAD_STALLED`。先把整个安装包收完、查完才转发的中间设备（公司网关、上网行为管理、带下载查毒的代理）
  每次都会触发；0.2.14 没有看门狗，这种网络只是慢。更新页失败卡和首页气泡又只给「重新下载」，点了还是同一个结果。
- `electron/updater.ts`：新增 `updateDownloadRetryStallMs`（120 秒），`downloadWatched` 多一个停住门槛参数。停住或代理
  连不上以后自动换直连重下的那一次用它；第一次仍是 `updateDownloadStallMs`（45 秒，尽快换条路），进度到过 100% 以后
  仍是 `updateDownloadSettleMs`（180 秒）。自动重下仍然只有一次。
- `src/renderer-v2/features/app/update-retry.ts` 新增 `updateOffersDownloadPage`：`UPDATE_DOWNLOAD_STALLED`（与主进程
  `downloadFailure` 字面量一致）和原有的 `UPDATE_SIGNATURE_REJECTED` 给「打开下载页」。更新页（`pages-maintenance.tsx`）
  失败卡为「重新下载」「打开下载页」「查看日志」，首页气泡（`App.tsx`）为「重新下载」「打开下载页」「查看更新」；
  Mac 验签没过照旧只给「打开下载页」。按钮沿用现成的文字和 `appReleaseDownloadUrl`（已在外链白名单），没有新句子；
  「必须更新」那道门本来就给，不动。
- 测试：`updater.test.ts` 钉住重下那一次过了 45 秒还在等、到 120 秒才报停住（代理连不上后的重下也一样），以及
  45～120 秒之间才来数据也能下完；`update-retry.test.ts` 钉住只有这两个错误代码给下载页；`app-check.mjs` 在更新页和
  气泡上点「打开下载页」，并核对同一句「超时」但不是看门狗报的照旧只给「重新下载」。真机、真实中间设备都没演过。
