## 开发

- 更新目录上 `service-status.json` 里的撤回名单、只撤哪几种安装包、分批放量、最低版本、最低版本只拦哪几种和 `updatedAt`
  加发布者签名（D85，深查「自身更新」Z-4 第 2 条）：复用发版给更新清单签名的那把 Ed25519 私钥（`XINGMANG_UPDATE_SIGNING_KEY`，
  不加新 secret），签的是这几项排好键的 JSON（`xingmang-service-status-guard/v1`），签名写在 `releaseGuardSignature`。
  客户端（`electron/service-status.ts`）验不过或没签名时把这几项当没读到：撤回名单、放量、最低版本照记住的那份，
  日志 `service-status.changed` 带 `releaseGuardRejected`；维护提示、已知问题、关功能等别的项照常读，在 Cloudflare 后台手改它们签名不受影响。
  以前拿到桶的上传权限或洛杉矶转发机的人，不用签名私钥就能把当前版本写进撤回名单、再换上一份真签过名的旧清单，让客户端「退回」旧版本。
- 写状态文件的三条工作流都在上传前签上（`scripts/service-status-signature.cjs sign`，私钥只给签名那一步）：
  service-status、rollback-release、publish-release 写分批放量那一步；publish-release 碰上线上那份还没签名时，放量不变也照原样签一份再传，
  0.2.25 的清单换上去之前线上那份就已经签好。service-status 的预览会提示线上那份没签名或签名对不上。
  0.2.24 及以前的客户端不看签名，行为不变。
