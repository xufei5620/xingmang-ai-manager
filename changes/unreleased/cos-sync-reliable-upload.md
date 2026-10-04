## 开发

- 腾讯云 COS 同步改成传得完、断了能接着传（0.2.15 同步在 60 分钟的 publish 作业里超时、补传又被一次 HEAD 超时打断）：`publish-release` 的 COS 同步从 publish 作业末尾拆成单独的 `cos-sync` 作业（挂 `cos-sync` 环境、不多一次批准、限 330 分钟，和 `sync-published-manager-cos` 共用 `cos-manager-publish` 并发组，后者也从 `update-feed` 挪过来、放宽到 330 分钟），失败后 Re-run failed jobs 只重跑它，已传好的文件跳过上传。
- 新增 `scripts/cos-transfer-retry.cjs`：读取（HEAD、完整回读、读 latest）最多 12 次、写入最多 10 次，指数退避加一半随机抖动，放弃前读取至少等约 3.5 分钟、写入至少约 5 分钟；只重试超时、连接断开、429/5xx 和 COS 诊断出的慢网络 400。Init 和分块按这些条件重试，Complete 与可覆盖的 latest 只在连接根本没建立时重发，不可变单次 PUT 只在回读 404 后重发；分块等待中其它分块失败会立刻被叫醒停下。星芒正式发布与手动导入单个安装包的分块期限放宽到 120 分钟。
- 新增仓库变量 `XINGMANG_COS_ACCELERATE`（默认关）：存储桶开了全球加速后设 `true`，四条 COS 工作流的上传改走 `<桶名>.cos.accelerate.myqcloud.com`，回读核对和客户下载仍用上海地址。`[manager-sync]` 日志新增 `retry` 行和传安装包时每 30 秒一行的 `stage-wait`。见 `docs/COS-SYNC.md`「网络不稳时」。
