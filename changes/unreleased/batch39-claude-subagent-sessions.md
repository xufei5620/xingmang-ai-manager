## 用户

- 用 Claude Code 聊一次，「记录」和首页「最近」里现在只算一条。以前它中途分出去做的小任务也各算一条，真正的前几次对话会被挤出
  「最近」，「N 条记录」也多算。

## 开发

- 第三十九批 B：`electron/provider-sessions.ts` 列 Claude Code 记录时把 `~/.claude/projects` 下每个 `.jsonl` 都算一条，Claude Code
  派出去的子任务（subagent）也各占一条：标题一般是 AI 交代给子任务的话，首页「最近」的三条容易被它们占满，「N 条记录」和 Claude Code
  那一栏的条数虚高。删记录时却把与记录同名的文件夹（子任务就在里面）当作这条记录的一部分一起删，列和删两个口径。
- 现在发现这一步按名字跳过 `agent-*.jsonl`（`isClaudeTranscriptFile`），再去掉落在某条记录同名文件夹里的 `.jsonl`
  （`claudeConversationFiles`；同名文件夹和删记录共用 `claudeCompanionDirectory`）。子任务文件不再探测，也不占 5 万个会话文件的
  上限；探测缓存里它们的旧条目在下一次整轮列表时清掉。依据是 npm 上的 Claude Code 安装包：2.0.30、2.0.77、2.1.0 把子任务写成项目
  文件夹里的 `agent-<id>.jsonl`，2.1.30 起（核到 2.1.289）写进 `<记录id>/subagents/[子目录/]agent-<id>.jsonl`；2.0.30、2.0.77、
  2.1.289 自己列会话都只认按 UUID 起名的文件。
- 删记录、看记录、导出不变。旧存法（2.0 到 2.1 初期）下子任务文件和记录并排，删记录原来就不连它们一起删，这次也没改；Claude Code
  默认 30 天清一次旧记录，这种文件一般早已被清掉。
- 测试：`provider-sessions.test.ts` 加三条：两种存法的子任务都不列、也不打开；普通子文件夹里的、名字里只是带 agent 的照列；子任务
  不占文件上限。删记录那条补上「列表里只有一条」。
