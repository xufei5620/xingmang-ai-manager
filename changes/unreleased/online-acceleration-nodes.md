## 开发

- 在线换节点（yoyo 2026-10-22）：更新目录里新增带发布者签名的 `acceleration-nodes.json`，客户端开机读一次、之后每小时读一次，
  签名对、又比记下的新才原样记进 app data，加速辅助进程每次连接时读它并再验一遍签名；没记过、读坏了、签名不对或发布者撤回了，
  就用安装包自带的节点（`electron/acceleration-online-nodes.ts`、`acceleration-worker-profile.ts`）。签名复用发版的 Ed25519
  钥匙，签的字以 `xingmang-acceleration-nodes/v1` 开头，跟更新包签名不能互换；只能换节点，规则仍在客户端代码里。
- 新工作流 `acceleration-nodes`：把 main 上的 `bundled-acceleration/profile.yaml` 签名发到更新目录，或发一份签名的撤回；
  预览段列出要发的线路（不列密码），上传段挂 release 环境要产品所有者批准，跟别的写更新目录的作业共用 `update-feed` 并发组。
- 加速辅助进程每次连接、测线路都重新读节点（以前第一次读到就一直用到辅助进程退出），在线节点中途换了下一次连接就用上。
