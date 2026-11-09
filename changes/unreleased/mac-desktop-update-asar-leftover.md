## 用户

- 修好 Mac 上 Codex 桌面端和 Claude Desktop 更新一次没成以后，再点更新每次都只说「没更新成，旧版还在」：
  上次留在「应用程序」里的半截副本现在能清掉，更新照常进行；更新成功后挪开的旧版也能真正删掉，不再悄悄占着空间。

## 开发

- `macos-desktop-app-installer.ts` 的八处递归删除改走新的 `electron/remove-tree.ts`（Electron 里用 `original-fs`）。
  主进程的 fs 被 asar 层改过，`lstat('…/Contents/Resources/app.asar')` 答「是目录」，Node 的递归 rm 对它
  rmdir、把 ENOTDIR 当成已删，最后删 Resources 报 ENOTEMPTY。ChatGPT.app、Claude.app 都是 Electron 应用，
  于是 replaceBundle 留下的 `.ChatGPT.app.xingmang-<hex>` 删不掉，下一次更新在 `removeInterruptedCopies`
  第一步就失败（2026-11-06 yoyo 的 Mac 日志：`ENOTEMPTY … rmdir '/Applications/.ChatGPT.app.xingmang-e5fff230b53a/Contents/Resources'`）。
  挪开的旧版（`-old-`）和没放进去的暂存目录也一样删不净；暂存目录里留着解开的应用时，下一次 `createStagingDirectory` 清它同样报错。
  `remove-tree.test.ts` 在真的 Electron 里（ELECTRON_RUN_AS_NODE）复现原报错并核对新写法删得干净、不跟链接走。
