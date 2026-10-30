## 开发

- 建窗口不再等安装包里的加速文件校验完（0.2.22 性能体检第 4 条，报告 `/mnt/project-files/0.2.22-性能体检.md`）。三十多兆的内核
  每次开机要整读一遍算 SHA-256，原来 `electron/main.ts` 在建窗口前 `await` 它；慢盘、杀毒软件逐字节扫的电脑上推测要 0.5~2 秒，
  绝大多数客户又根本不用加速。读还是开机就开始，跟以前一样和迁移、命令行探测叠着跑。
- `electron/bootstrap/acceleration.ts`：`createAccelerationHost` 改收这个读的 Promise、自己是 async，读完那一刻建宿主、立刻
  `recover()` 改回上次崩溃没改回的系统代理，不等任何人用加速，所以开机恢复代理不会被推迟或丢掉。`createAccelerationServices`
  改收 `host: Promise<AccelerationHost>`，加速服务照旧在注册 IPC 之前同步建好。
- `electron/acceleration-service.ts` 新增可选的 `ready`：后端和「文件坏了」晚到时，用到后端的操作都排在它后面（服务那条串行队列
  从等它开始）；到手之前 `awaitingPreviousOwner` 答「没在等」，「重新检查」那一项也还没有。`recheckAccelerationBundle` 在服务和
  `createUserAccelerationApi` 上都改成每次现看的 getter，坏没坏照旧只在启动时读坏了的那次运行才有。不给 `ready` 的是旧行为。
- `electron/main.ts`：下载线路等宿主建好才接上；睡眠唤醒的两个监听一直挂着，没有宿主（还没建好、Linux、加速文件没带或读坏了）
  时什么都不做，跟以前不挂一样；退出时放掉宿主那一步等这个 Promise，退出时还没读完的，读完建出来的那个也放掉。
  `main.test.ts` 跟着改了这几处的源码钉子，另加一条：启动回调里不许 `await` 加速文件的读取或宿主。
- 校验改成一块块算：`electron/bounded-file.ts` 新增 `readBoundedFileDigest`，跟 `readBoundedFile` 同一套检查（打开前后路径快照、
  `O_NOFOLLOW`、单链接普通文件、大小上限、读前读后 fstat 比对），每次读 1 MB 交给 hash，只交回摘要、大小和要的前几个字节。
  开机峰值少占三十多兆内存（推测），主线程上也不再有一次算完整个缓冲区的长摘要。`acceleration-bundled-config.ts` 改用它，
  `assertSafeDataFile` 和两个上限（内核 100 MB、节点 2 MB）照旧；Mac 内核的 Mach-O 检查改看前 32 字节加整个文件的大小
  （`assertMacosAccelerationBinary` 加可选的 `byteLength`，其他调用方不变）。
