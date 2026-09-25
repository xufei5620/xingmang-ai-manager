## 用户

- 在聊天里删掉的对话现在真的从电脑上删掉了。以前从老版本升级上来的，旧版留下的那份聊天记录一直还在，清空聊天记录后下次打开旧对话又会冒出来。
- Windows 卸载时的勾选项改成「同时清除登录记录和聊天记录」，勾上后聊天记录也一起删掉。默认仍然不勾，不勾的卸载后什么都不删。

## 开发

- `renderer-v2/features/chat/storage.ts`：旧版 localStorage 聊天副本（本账号键、`solov`/`sub2api` 别名、v1 键）在第一次写进文件成功后才删除，写失败照旧保留；删除前先记 `xingmang-ui-v2:chat-migrated:<scope>` 标记，文件记录为空时有标记就不再回头读旧副本。文件里已有记录的老用户，下次打开聊天时把残留旧副本一并删掉。`createHistoryWriter` 新增可选第三参 `afterFirstSave`。
- `electron/uninstall-cleanup.ts`：勾选卸载清理时除登录记录外，再删 `userData` 下的 `chat-history` 与 `Local Storage` 两个文件夹；逐项走 `removeSafeDataFile`，树里遇到链接、目录联接或多链接文件一律拒绝并跳过（I8），其余照删，没删干净的并进退出码 16。`build/installer.nsh` 勾选项文字随之改名。
