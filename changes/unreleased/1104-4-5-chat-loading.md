## 开发

- #1104 第 4 条：`features/chat/ChatPage.tsx` 的 `reload` 读出 `loaded.warning` 时把它交回去，`reloadHistory`
  照 App.tsx 断网重试的先例弹一条 `warn` 提示，以前直接 `return`，红条和按钮原样不变，只看到按钮转了一下。
- #1104 第 5 条：App.tsx 的 `pageLoading` 挪进 `features/app/PageLoading.tsx`，聊天页读记录时在
  `section[data-loading]` 里渲染它；`chat.css` 让加载中的 `.chat-page` 不按两栏排，跟 Suspense 那块摆在同一处，
  先等代码再等记录时转圈不跳位置。聊天浏览器用例加读记录卡住（`historyReadHold`）一条，重读失败那条补提示断言。
