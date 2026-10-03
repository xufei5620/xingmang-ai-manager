## 开发

- 测试：`scripts/cos-sync-utils.test.cjs` 里「上游 ETag 变了不发布半截文件」那条偶发报 `EBADF: bad file descriptor, close`
  （10-03 沙箱整套 `npm test` 一次、#818 的 linux-test 一次）。根因在 `scripts/cos-sync-utils.cjs` 的 `downloadResource`：
  写入流拿着 FileHandle 的同一个文件号，`autoClose: false` 拦不住显式的 `destroy()`，`finally` 里流关一次、`handle.close()`
  再关一次，谁先谁后看线程池。ETag 不符时流还没人监听，抢输的那次 EBADF 成了未捕获异常；下载成功时每次都重复关，中间隔着
  `link`，这个号要是已被别的文件拿去，关掉的就是别人的。现在只有 FileHandle 持有这个号：写入走 `handle.write`（只写进一部分的
  接着写，一个字节都写不进就报错），由它在进行中的写完成后关一次。沙箱压测 ETag 不符：改前 3200 次出 17 次未捕获，
  改后 9600 次 0 次。
- 新增两条用例：一条在旧代码上每次都红（下载一还回文件号就另开一个文件，查它没被关掉，并查没有绕过 FileHandle 的关闭）；
  一条让磁盘每次只收 4 KB，查下载的字节一个不差、写不进时报错而不空转。超时和原有用例都没动。
