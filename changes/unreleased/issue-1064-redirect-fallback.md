## 开发

- 账号和中转请求碰到跳转时 Electron 的 net.fetch 只抛 `Redirect was cancelled`，不交回 opaqueredirect，
  `network-failure.ts` 以前认不出这句：账号请求原样抛英文、不走中文提示，`relay-line-fetch.ts` 里
  「直连被跳走就退回备用线路」那一段在生产环境从来走不到。现在把这句归进 intercepted：只读请求退回
  备用线路并报给线路那边，写请求照旧不重发；账号请求给「当前网络把这次请求拦到了别的页面」那句现成中文。
  只做了兜底，给账号请求换网络栈的根治另做（#1064）。
