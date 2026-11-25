## 用户

- 修复了在 Codex 桌面端附带文件发起的对话，在首页「最近」和记录页中标题显示为一段英文的问题。

## 开发

- Codex 桌面端附了文件时，会把「# Files mentioned by the user:」和一串「## 文件名: 路径」垫在客户的话前面，
  客户打的字在「## My request for Codex:」后面；`threads.title` 存的是整段，首页「最近」只露出前面那段英文。
  `provider-sessions.ts` 的 `codexSessionTitle` 现在跟 Codex 自己的 `strip_user_message_prefix`（openai/codex
  `codex-rs/protocol`，同一个分隔行、在第一处切开）一样，只取分隔行后面的字；只附文件没打字的，拿文件名当标题；
  两样都取不到的照旧整段收成一行。IDE 插件带编辑器上下文的那种（「# Context from my IDE setup:」）同样受益。
  另加一条随机输入用例，钉住不带这两种前缀的标题和以前完全一样。
