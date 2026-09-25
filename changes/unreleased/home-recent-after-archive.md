## 用户

- 在「记录」页归档或恢复一条对话后，回到首页，「最近」一栏会马上跟着更新，不再短时间内还显示刚归档的那条。

## 开发

- #544：`SessionsPage` 的 `onResumed` 改名 `onSessionsChanged`，归档 / 恢复成功后也调用，经 `BusinessPage` 接到 `App.tsx` 的 `refreshRecent()`，作废首页「最近」的 60 秒缓存并让正开着的首页重读。浏览器用例 `archiving a session on the sessions page refreshes the home recent card right away`（夹具新增 `?sessionArchive`）。
