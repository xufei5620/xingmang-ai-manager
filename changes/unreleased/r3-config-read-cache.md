## 开发

- 0.2.25 总单第 77 项 R3（0.2.24 深查「性能和资源」R3）：开机那两秒里首页工具区、开机补密钥（三遍）、线路跟随接连要五遍 `config:get`，
  每遍都把四家的配置文件、来源记录、线路跟随记录从头查一遍（沙箱量一遍约 380 次 lstat / realpath，全在主进程上同步做）。
- 新加 `electron/config-read-cache.ts`：`config:get` 从磁盘读的那部分（四家的配置和钩子、来源记录、线路跟随记录）留 3 秒，
  三样都没变才接着用：星芒自己没写过（`executeFilePlans`、Codex 定点改写 `replaceTomlFile`、来源记录、线路跟随记录写之前和写完都记一笔）、
  读过的每份文件和各家配置文件夹的身份/大小/修改时间没变（读之前取，`withRecordedConfigReads` 交回）、账号和站点线路地址一样。
  算账号是否匹配、自动修好的提示、线路状态、工作区这些不从磁盘读的照旧每次现算；保存、核对快照、取明文照旧每次现读。
  只在正式运行开（`main.ts` 传 `configReadCacheMs`），缺省 0 = 旧行为，测试不受影响。沙箱量：连着再读 4 遍从 17.4ms 降到 2.9ms。
- 开机补密钥（`account-bootstrap.ts`）这一轮一家都没写时不再读第三遍复核配置。
- 用例：`electron/config-read-cache.test.ts`（含随机输入：不管内部写、外部改、时间怎么交错，读到的都不会比最近一次能看见的改动旧）、
  `electron/system-service-config-read-cache.test.ts`（星芒写配置、外面改文件、工具登录写出新文件、写来源记录、写线路跟随记录、换账号、换站点都重读），
  `account-bootstrap.test.ts` 补「只有写了才复核」一条，原来那条从 3 遍改成 2 遍（旧代码上红）。
