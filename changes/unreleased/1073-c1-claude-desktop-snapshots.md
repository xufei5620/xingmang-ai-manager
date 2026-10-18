## 开发

- `electron/claude-desktop-config.ts` 五笔写入（保存、开机修型号清单、换线路/换密钥、切官方登录、切回星芒）
  各抄一份的「读一遍、记下读到的」收成 `createFileSnapshots`，三处只改一个顶层字段的写法收成
  `setTopLevelField`，五处「超过文件大小上限」收成 `assertWithinSizeLimit`，剩下三处 `'3p'` 换成常量。
  写哪些文件、核对哪些文件、读的顺序、留的 .bak 和还原都不变；新测试先在旧代码上钉住五处交给提交的
  文件清单和读到的内容、切换登录方式的排版和写入大小上限（#1073 评论第 1 条）。
