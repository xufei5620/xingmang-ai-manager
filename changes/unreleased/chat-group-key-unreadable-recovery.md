## 开发

- `chat-key-store.ts`：`chat-group-keys.dat` 用当前系统密钥解不开或读不懂时（`ChatKeyCacheCorruptError`），
  `read` 和几条删除路径当成空的，`upsert` 先确认当前系统加密能来回解开，再把旧文件改名成
  `.corrupt-<时间>` 留给客服（最多留三份）、写入新签的这把。做法照 `managed-cli-key-store.ts`；
  大小超限、链接、被占用这类读不到的错照旧报错，不挪文件。修 0.2.24 深查「数据和迁移」DM-1。
