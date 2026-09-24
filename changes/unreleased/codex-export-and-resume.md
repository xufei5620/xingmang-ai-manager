## 用户

- Codex 的对话记录里有读不出来的内容时，导出的文件和预览都会写明「不完整」，不再当成完整的备份。
- 归档了某个文件夹里最新的一条 Codex 对话后，同一文件夹里还在用的旧对话又能点「接着聊」了。

## 开发

- #491：`codex-sessions.ts` 的 `detail` 在跳过坏行或超长行（`invalidLines > 0`）时置 `messagesTruncated`；`exportMarkdown` 在文件末尾写与其它工具相同的不完整提示，并返回可选的 `truncated`（缺省 = 完整）；`provider-sessions.ts` 把它透传到统一导出结果，不再写死 `false`。
- #497：`renderer-v2/features/tools/recent-workspaces.ts` 的 `latestSessionIdsByWorkspace` 跳过归档记录，归档的最新一条不再占掉同一工具、同一目录里较旧活动会话的「接着聊」。
