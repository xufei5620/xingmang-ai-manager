## 用户

- 聊天能存的对话从 50 个提到 200 个，天天用聊天也不用隔一两个月就停下来删对话。存满 200 个以后还是原来那句提示，删掉一些不要的就能接着聊。

## 开发

- 深查 D6（聊天页 C9，选「放宽」）：渲染层 `chat/storage.ts` 的 `MAX_CONVERSATIONS` 和主进程 `ai-chat-history-store.ts` 的 `MAX_CHAT_HISTORY_CONVERSATIONS` 从 50 提到 200（两边有意重复，各自的测试钉着 200 可存、201 拒绝）。`useChatController.ts` 三处写死的 50 和那句「最多保存 N 个对话，请先删除不再需要的对话」改用 storage 导出的 `MAX_CONVERSATIONS` / `conversationLimitMessage`；设置页「导入」的两句（`features/app/data-transfer.ts`）里的数字也跟着它走。字一个没加，只是数字变了。
- 对话目录的条目上限 `MAX_DIRECTORY_ENTRIES` 从 256 提到 1024：保存到一半崩了，删掉的对话文件要等下一次保存才清，新旧两批可能同时在，256 留给 200 个对话不够余量，超了整份记录读不出来。
- 不让数量涨四倍把电脑吃住：主进程每次保存要逐个核对没改动的对话文件，以前每个文件都把整条上级目录同步走一遍（Windows 上每个文件几十次同步 lstat），200 个时一次保存在 Linux 上就要 10.6 ms（50 个时 3.1 ms），出字时每 2 秒存一次。`safe-local-data.ts` 新增 `assertSafeDataFiles`：目录只走一遍，每个文件照旧单独查「单链接普通文件」和 realpath 一致（realpath 也会看到走完目录之后才被换成链接的上级），`assertSafeDataFile` 抽出同一份逐文件检查，行为不变。200 个时降到 2.6 ms，比原来 50 个还省。
- 聊天页左边对话列表的每一行改成 memo（`ChatPage.tsx` 的 `ConversationListItem`，回调走跟消息行一样的稳定对象）：出字时每 50 毫秒换一次列表，以前整排连同每行的菜单都重画。浏览器夹具（开发版 React）实测每段字的主线程耗时：199 个对话 32 ms → 14 ms，50 个对话 19 ms → 10 ms。内存：199 个对话（每个 6 条消息）比 5 个多约 5 MB。
- `docs/TEST-BASELINE.md` 和 `AGENTS.md`：需要建符号链接特权的用例从 11 条变成 12 条（`safe-local-data` 多一条）。
