## 开发

- 一键检测「电脑里另外设过的工具地址或密钥」看终端设置文件时，先异步排除不在的文件、在的照旧经 `readSafeUtf8File` 整套核过再读，并按 `async-map.ts` 限流同时读：以前八到十一个候选一个接一个交给 `readSafeUtf8File`，不在的也要在主线程上把主目录整条同步核一遍，Windows runner 上这一项压着夹具 100ms 的时限跑完，`diagnostics.test.ts`「passes %s because the written configuration still wins」两周内偶发「检查超时」两次（11-11 macos-test、11-20 windows-test vitest-2）。新增 `diagnostics-override-checks.test.ts` 钉住只有在的文件才走安全读取。
