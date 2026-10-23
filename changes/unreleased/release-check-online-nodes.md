## 开发

- 发版前核对在线加速节点（#1359）：`publish-release` 的 Windows、Mac 出包作业在准备加速资源之前跑
  `scripts/acceleration-nodes.cjs check`，线上有一份客户端会用的在线节点、又跟这次装进安装包的不一样就停下，
  提示先跑一次 `acceleration-nodes`（publish 或 withdraw）。客户端记下过在线节点后一直优先用它，不拦的话新版换了
  节点，老客户升级后也还连旧节点。线上没有、撤回过、客户端不收的都放行；读不到（404 以外）也停下（#493）。
