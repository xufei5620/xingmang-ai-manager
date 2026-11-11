## 开发

- 手里已经下好一版、3 小时那次定时检查查到更新的版本时（`refreshDownloaded`），顶掉之前先量盘（深查 Z-1 第 1 条）。以前
  直接顶掉，阶段切成 available，随后 `download()` 下载前量盘发现不够就停在那儿：手里那份还在盘上却不算「下好了」，退出时、
  开机时都没东西可装。现在 `refreshDownloaded` 在查之前先读一次剩余空间，`update-available` 里用和 `download()` 同一个算法
  （`resolveUpdateDiskShortfall` + `requiredUpdateDiskBytes`）算新版本要多少，不够就不顶、留着手里那份，记一条
  `download.skipped.disk`；量不出来当够（旧行为）。手里那份够不上最低版本时照样顶掉，让「必须更新」门里显示要清多少空间。
  顶掉以后新版本因为网络没下成那一半走 Z-3 的补试。下载前那段量盘抽成 `readFreeDiskBytes` 共用，行为不变。
