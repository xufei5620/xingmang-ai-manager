## 用户

- 首页「最近」卡现在可以直接「接着聊」：点一下就接着那个文件夹里最近的一次对话，
  不用先跳到记录页再找一遍。和记录页一样，同一个工具同一个文件夹只有最新的那条给按钮。

## 开发

- `features/tools/api.ts` 的 `launch` 以前只把 mode 传给 `launchCodexDesktop`，
  CLI 分支直接把它丢了，所以工具箱那一层根本发不出 `resumeLast`。改成两侧各取自己
  认得的取值：codexDesktop 认 `'open' | 'restart'`，四家 CLI 认 `'new' | 'resumeLast'`；
  不点名 CLI 模式时仍按两个参数调 `launchCli`，线上行为与以前一致。
- `features/tools/Home.tsx` 的「最近」卡复用 `latestSessionIdsByWorkspace`（#292 记录页
  用的同一个纯函数）判断哪一行能续接：续接参数是 CLI 按工作目录找最近一条、不按会话 id
  挑，所以按钮只长在每个（工具 × 目录）组合最近的那条上，归档过的记录不给按钮。
  判断依据是 `api.recent()` 取回的整份记录（60 条），不是卡片上显示的那 3 条。
- `App.tsx` 的 `launch` / `requestLaunch` / `launchRemembered` 把 CLI 模式透传下去；
  记住的目录已经不在时仍退回目录选择器开新对话（N7 的老行为）。
- Grok 在没有历史会话时会直接报错退出，这是 CLI 自己的行为，按 #292 的结论不加兜底。
