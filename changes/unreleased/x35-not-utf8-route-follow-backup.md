## 开发

- 开机换线路的定点改写（`applyProviderRouteFollow`）原来写成就删 .bak，碰上老记事本存成 GBK 的配置，写回后那几个中文成了「�」、原样一份不剩
  （D78 跟进）：`executeFilePlans` 的 `discard` 遇到写回前不是 UTF-8 的文件改为留下这次的 .bak，照每个文件 5 份的老规矩一起轮换，运行日志
  `config/config.not-utf8-rewritten` 记下它的位置；写回的那份已是 UTF-8，下回换线路照常删，UTF-8 配置的行为不变。不加界面字。
