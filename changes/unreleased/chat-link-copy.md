## 用户

- 聊天回复里的网址变成能点的样子，点一下就把网址复制下来，粘贴到浏览器地址栏就能打开；链接文字看不出去哪儿时，后面会用小灰字写上网站名。为了安全，链接仍然不会直接打开。

## 开发

- `src/renderer-v2/features/chat/ChatPage.tsx`：Markdown 的 `a` 改由 `ChatLinkText` 渲染，http/https 链接是按钮，点击经 `api.copyText` 复制 `URL.href`，成功走底部提示条，失败照旧弹「手动复制内容」；其它协议照旧是不可点的文字。判断和域名提取放在新文件 `features/chat/links.ts`（域名取 `URL.hostname`，`https://a@b` 显示 b），单测 `links.test.ts`，浏览器用例在 `features/chat/browser-check.mjs`（第十六批候选 7）。
