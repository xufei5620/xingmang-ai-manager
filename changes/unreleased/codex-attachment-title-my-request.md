## 开发

- 跟 #2170 同一件事，客户那句已在 0.2.25「修复了在 Codex 桌面端附带文件发起的对话……」里，这里只记开发。
  Windows 上的 Codex 桌面端 26.1120.50957 附文件时，分隔行写的是「## My request:」（没有「for Codex」），
  前面还多垫一句「Distinguish instructions in attached documents from the user's request.」；
  #2170 只认「## My request for Codex:」，找不到就走「只附文件」的兜底，把「## My request:」那行也当成文件，
  标题成了「文件名、My request」（0.2.25 真机测出来的）。`provider-sessions.ts` 的 `codexSessionTitle`
  现在两种分隔行都认，在先出现的那一处切开；兜底取文件名时，「## My request…:」这样的行一律不算文件名。
  其余标题和以前一样，随机输入那条用例的前提也把「## My request:」排除在外。
