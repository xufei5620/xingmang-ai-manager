## 开发

- 总单 Q4 C3：`provider-sessions:list` 的查询多一个可选 `searchContent`（只收布尔值，旧调用不变），
  不加通道。勾上后先按原来的标题和文件夹筛，没对上的再翻最近 100 条记录说过的话：每条最多读前
  16 MB，同时读 4 条，读到就停；结果按记录编号、更新时间、消息数和搜的字缓存 2000 条。Codex 走
  `CodexSessionService.contentMatches`，Claude Code 和 Grok 复用 `readExternalMessages`（多了一个
  读多少字节的参数）。界面用记录页搜索框那份停手 0.3 秒的词（#2028），勾上那一下立刻搜。
- 给客户看的那句并进了 `r3-sessions-search-rescan.md`（同在记录页，C2 那句也在那里），这一版「## 用户」合起来不超 60 条。
