## 用户

- 记录页打开一条对话后，多了「彻底删除」：公用电脑或把电脑交给别人前，可以把这条对话从这台电脑上真正删掉（Claude Code、Codex、Gemini CLI、Grok CLI 都能删）。删之前会再问一次，删了就找不回来。

## 开发

- 新通道 `provider-sessions:delete`（`ipc-contract.ts` / `preload.ts` / `ipc.ts`），入参只有会话 id；`ProviderSessionCapability.operations` 加可选的 `delete`。
- `provider-sessions.ts`：删除前重新扫一遍该工具的记录目录，不信任缓存里的 id→路径；文件必须是单链接普通文件、真实路径在记录目录内；Claude 同名子文件夹、Grok 整个会话文件夹只在是真实目录且严格在根目录之下时才删，Grok 文件夹里还有别的会话时只删它自己的两个文件。删完同步清探测缓存。
- `codex-sessions.ts`：`delete()` 与归档共用串行队列，在一个事务里删 `threads` 行、先删 rollout 再 COMMIT，删不掉就回滚；不做数据库备份（留备份等于没删）；原文已不在时只删索引；有未收尾的归档/恢复时拒绝。`permanentDeleteAllowed` 改为跟随可写状态。
