## 开发

- 开机不再整读加速内核（0.2.24 启动速度深查 S-3）：网络加速 2026-10-30 下线后，Windows、Mac 安装包每次开机仍把三十多兆的 `mihomo(.exe)` 和节点文件整读一遍算 SHA-256，只为 `recover()`。
  现在由 `bootstrap/acceleration.ts` 的 `createAccelerationHostLoader` 定什么时候读：开机只用 `hasAccelerationProxyRecoveryRecords`（数据目录下恢复记录和它的 `.lock` 两次 lstat）看上次崩溃有没有留下没改回的系统代理，有才马上读文件、建宿主、改回（日志 `acceleration.recover.pending`）；没有就等加速服务第一次真要用后端时再读（`createAccelerationService` 的 `ready` 可以给函数，换账号、停别的账号、退出这些用不着后端的操作不去调）。
  检查页「加速功能」那一行在加速下线后本来就不显示，现在也不为它去读文件（`readAccelerationBundleStatus`）。退出时建好了的宿主照旧放掉，没用到的不读。校验一项没减：真要读时照旧整读、核哈希，启动内核前复制件的复核也不变；`recover()` 和 `createAccelerationHost` 都留着。
