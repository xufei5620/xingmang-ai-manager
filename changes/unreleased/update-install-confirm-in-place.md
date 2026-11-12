## 开发

- 「重启并安装」确认框抽成 `features/settings/UpdateInstallDialog.tsx`：版本卡照用（共用卡上的 `useOperation`），
  气泡、状态栏版本号、侧栏 `nav-update`、气泡上安装失败的「重新安装」改由 `App.tsx` 就地挂 `UpdateInstallConfirm`，
  不再 `navigate('updates')` 再经 `requestUpdateInstallConfirm` 让版本卡弹框（那套请求/取走/订阅删掉）。框里的字、
  `installUpdate({ askIfInstalling: true })` 和主进程那几问都没变。yoyo 2026-11-10：要跳转、更新说明又长，不方便。
- 版本卡「vX 更新内容」原来把 `releaseNotesText` 整段塞进一个 `<p>`：electron-builder 把整份 release-notes.md 写进
  latest.yml，主进程截前 20000 字，客户看到的是要装的那一版连着前几版、换行全被吃掉的一大段（0.2.22 客户截图），
  按钮被挤到最底。`release-notes.ts` 新增 `releaseNoteItems`：只取要装的那一版那一节（找不到取第一节），按
  `bundle-release-notes.cjs` 同一拼法拆成一条一行；不是列表的照旧整段。说明区 `.v2-version-card-notes-body`
  限高 `min(240px, 34vh)`、区内滚动，装完后的「更新了什么」同样受益。只对装上这一版以后的下一次更新起作用。
