## 用户

- 设置中的用户协议和隐私政策，历史账号也可正常打开，并按排版显示。

## 开发

- 设置 › 隐私数据的「用户协议」「隐私政策」以前自己调 `getLegalDocument(kind)`、不带账号来源，主进程按当前账号读：
  历史账号（sub2api）那边没有协议，点了只报「当前账号暂不支持此功能」；星芒账号读到的也原样塞进 `<pre>`，显示成 Markdown 源码。
  现在两颗按钮只调 `BusinessActions.openLegal`，打开 App 外壳里欢迎页、登录框共用的 `features/auth/LegalDocument`
  （固定读星芒账号那一份、MarkdownView 排版、读失败有「重新读取」），设置页自己的那个弹窗和 `.v2-business-legal` 样式删掉。
  外壳没给 `openLegal` 时这一行不出现（缺省 = 不显示，只有没接外壳的夹具会这样）。
  0.2.25 设置客服反馈复查第 1 条；`app-check.mjs` 两种账号各一条用例，旧代码上红。
