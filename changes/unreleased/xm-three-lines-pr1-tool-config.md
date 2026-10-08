## 用户

- 星芒账号换连接线路以后，各个工具的配置只改连接地址这一处，你自己加的注释和设置原样保留；工具开着也照样换，重开工具就走新线路。
- 首页每个工具会写明它现在走的是哪条线路（洛杉矶、CF 或其他地址）；因为连不上而换了线路时，会提醒你哪些开着的工具要重开，设置里可以关掉这个提醒。
- Claude Desktop、WorkBuddy、OpenCode 开着时换了线路，关掉它们以后星芒会自动换过去，不用再回来点「重新检测」。

## 开发

- xm 三线路 PR-1（C9、(f)、C10、C11、C12、C19、C17 的 route.followed）：星芒账号（solov）换线路改由主进程 `followToolRoutes` 定点改写工具配置里的那一个地址（`tool-route-rewrite.ts` 字面量替换后整份重解析比对，`config-files.ts` 的 `planProviderRouteFollow` / `applyProviderRouteFollow` 走两阶段提交、本次 .bak 写成即删），不查模型、不碰 Key；写前记 manual、写后用新指纹重记 account 并原样带回模板版本号。历史账号（solov-api）照旧走渲染层 `followRelayRoute` → 整份写入，一行未改。
- 被外部改回 24 小时内两次标「由其他工具管理」并停手；暂时性失败每 5 分钟重试、最多 12 次；改完 60 秒回看一次。状态存 `tool-route-follow.json`（只存指纹与时间）。
- 迁移前原件：每个工具第一次定点改写前整套备份一次，进现有「备份」页（`pre-save` 类型，200 份上限内），没有另开子目录和新界面分组。
- 服务状态文件新增 `toolRouteRewrite: "merge"`（R6），缺省为定点改写；`service-status` 工作流加对应输入。
- 外部客户端开着时的换线（C11）：只对星芒账号，每 5 分钟和窗口回到前台时（间隔至少 2 分钟）用 `runtime.stillRunning` 轻量看一眼进程，退出后整轮检测一次完成换线；看不出开没开的每 15 分钟整轮检测一次。
- 零新增 IPC 通道：复用 `network:relay-route-changed`，渲染层要的线路标签、重开提示、R6 模式放进配置摘要与设置快照的只读字段。
