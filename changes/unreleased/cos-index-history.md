## 开发

- COS 星芒下载清单 `xingmang/latest.json` 多一个可选的 `history` 字段，记最近 3 个旧版本的安装包（地址、大小、SHA-256，不记 zip、blockmap 和 latest*.yml）。每次同步新版本时，被替换下来的安装包挪进去；条目原样搬，不重新上传。教程下载页在当前版本被撤回时从这里挑上一版（#961）。`schemaVersion` 仍是 1，不带 `history` 的老清单照常读写。
- `sync-published-manager-cos` 加「只补历史」选项（`history_only`，必须填标签）：从 GitHub Release 取这一版的安装包，把 COS 上同名文件完整读一遍核对，全部一致才把它记进 `history`，不上传任何文件、不改当前版本。新增的 `verifyFile` 只读不写，对象不在就报错。
