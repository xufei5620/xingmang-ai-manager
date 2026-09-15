# macOS 本机加速适配

> 后续授权：用户已明确要求升至 0.2.4、提交 PR、合并 main，再本地打包发布 macOS arm64/x64。本文此前“仅本地/不提交/不打包”描述保留作为该阶段记录，本次发布以新授权为准。

用户已确认本轮完成本地实现和验证：Apple Silicon / Intel、现有节点与选线、累计 20 分钟、系统代理及恢复、私有双架构打包资源。TUN 与线上发布另行处理。用户随后明确收紧范围：只做功能适配及必要本地测试，不提交 PR，不生成应用安装包，不发布；不复制节点凭据到仓库。

## 当前事实

源码基线 ac7650b（0.2.3）。现有 worker、开发配置和打包配置只允许 win32；资源清单只接受 mihomo.exe。Mihomo 运行管理、线路探测、账本和 renderer 可以复用。附件是 12 条内联 Hysteria2 节点，未含规则、订阅或 TUN 设置。

## 设计

1. 使用官方 Mihomo v1.19.29 的 darwin-arm64 和 darwin-amd64-v1，先校验官方资产 SHA-256，解压后校验 Mach-O 架构，资源接口按架构分开，本轮不准备发行安装包。Windows v1 manifest 保持兼容；Mac v2 manifest 固定 platform、arch、coreFile=mihomo、资源 SHA-256。发布构建必须拒绝目标架构与清单不一致。
2. 系统代理使用 macOS SystemConfiguration 原生 helper，完整保存每个物理网络服务的代理字典（包括 PAC/WPAD、HTTP/HTTPS/SOCKS 与 bypass），避免通过 networksetup 重建配置丢失未识别字段。原生 API 提交前取得授权与配置锁；通过 stdin/stdout 的有界 JSON 协议，仅提供恢复、启用回环端口、停止和只读检查。绝不支持任意脚本、命令或任意配置写入。
3. 原生 helper 不以 root 运行、不安装常驻系统服务、不修改系统授权数据库。授权不足时使用 macOS 标准授权机制；用户取消必须原样保留网络。helper 生命周期内保留授权，恢复不依赖父界面存活。全局操作锁、写前 journal、逐字段/服务比较及回读防止覆盖其他代理软件的后续变更。恢复未确认则保留 journal、保持必要进程并明确失败。
4. 沿用独立 Electron worker：主进程 IPC 断开时先恢复系统代理，再停止 Mihomo；Mac native helper 额外处理 worker 断连；硬杀/断电后下次启动根据 journal 恢复。系统代理只覆盖遵循系统代理的应用，不修改 DNS、路由或启用 TUN。
5. helper 为本地运行及测试按架构编译到 dist-native；未来发行时需接入现有应用签名流程；节点资源留在仓库外，包内哈希固定在 ASAR metadata。签名可能改变嵌入二进制字节，因此打包必须处理最终二进制哈希或保持已固定内核字节，并对最终包重新验证，不能只验证签名前目录。
6. 共用 renderer 和 20 分钟账本；连接与 HTTPS CONNECT 探测成功、系统代理回读一致后才显示 active 并计时。正常停止、到期、退出、账号切换遵循原清理顺序。错误文案固定中文，不打印 YAML、内核原始日志或代理认证凭据。

## 验证

- 自动化使用虚构节点和隔离临时数据，覆盖资源错架构/篡改、首次授权取消、原设置恢复、部分写失败、外部变更、并发实例、死进程恢复及 worker 入口。
- 真实内核先通过无系统代理修改的 CONNECT 测试，再验证开始/停止及父进程断连恢复；记录操作前后代理配置一致性。保持其他代理软件配置，若现有 TUN 影响出口判断，报告观测范围。
- 主机为 arm64；x64 完成编译、Mach-O/签名/资源检查，有 Rosetta 才运行兼容测试，不声称完成 Intel 真机验证。
- 类型检查、相关测试和项目检查；必要的内核/helper 编译验证不生成应用安装包。所有失败按基线和复核证据记录。

## 参考

- https://github.com/MetaCubeX/mihomo/releases/tag/v1.19.29
- https://developer.apple.com/documentation/systemconfiguration/scpreferencescreatewithauthorization(_:_:_:_:)
