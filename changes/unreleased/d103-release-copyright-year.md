## 开发

- 安装包上的版权行不再写死 2026，按出包那天的北京时间取年份（D103，0.2.24 深查 打包构建 PK-13）。
  `electron-builder.config.cjs` 的 `copyright` 改由 `scripts/release-copyright.cjs` 的 `buildReleaseCopyright(new Date())` 给出，
  Windows 安装程序和主程序文件属性里的「版权」、Mac「关于」那一行都读它。发版跑在 UTC 的 CI 上，按北京时间算是为了
  1 月 1 日凌晨 0 点到 8 点出的包也写新的一年；中国不用夏令时，固定东八区，不依赖 Node 的时区数据。
  `scripts/release-copyright.test.cjs` 钉住跨年那一刻和时间无效时报错，`update-release-utils.test.cjs` 那条出包配置断言改成比对出包那一刻的年份。
