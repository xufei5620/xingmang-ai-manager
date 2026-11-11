## 开发

- Fable 手机遥控 YF-19：电脑上能加几个干活的文件夹（最多 5 个），手机上发「文件夹」列出来、发「文件夹 2」切过去。
  设置多一个可选的 `workspaceDirectories`（`codex-remote-store.ts`，按加的先后、含正在用的那个；缺省 = 只有
  `workspaceDirectory` 那一个，老设置照读）。`codex-remote:choose-workspace` 改成「加进单子」，还没有正在用的才用它；
  新加两条主窗口业务通道 `codex-remote:use-workspace` / `codex-remote:remove-workspace`，入参只是界面上显示的那串字
  （`parseRemoteWorkspaceChoice` 限长），主进程只拿它跟加过的单子比，渲染层没法借它们让 Codex 去别的文件夹（I5）。
  加的时候照旧过 `validateRemoteWorkspace`（不许桌面、主目录这类大文件夹），切过去之前再查一次还在不在。这一轮还没做完
  （含等你同意）时两边都不换；换了从新对话开始，手机上切的那次不再补「前面的记不得了」。快照只在不止一个时带
  `workspaces`。用户行并在 `codex-remote-fixes-0224.md`。
