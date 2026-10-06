## 开发

- 安全修复：以管理员身份运行星芒时，收紧 `ProgramData\XingMangAI`（装、更新、卸载工具，或准备安装临时目录时都会走一遍）的顺序留了个可写空窗。`protectWindowsDirectory`（`electron/trusted-temp.ts`）原来先 `icacls /reset /T` 整棵树、再单独加固根：`/reset /T` 这一步会让根重新继承 `ProgramData` 的 ACL（对 Users 可写），到下一步加固根之前，普通账户能在根里新建文件；随后的 `/setowner /T` 把这些文件的属主一律改成 Administrators，而作者在建文件时就能把 DACL 设成只有 SYSTEM/Administrators，于是最后的逐项核对放行——等于普通用户把自己的文件塞进提权执行路径，还带着一副可信的 ACL。
- 改法：把加固根挪到第一步（断继承、只给 SYSTEM/Administrators），根从这一刻起就不再对普通用户可写；再用 `icacls <root>\*`（只针对内容、绝不碰根本身）重置子项，让它们重新继承、并修掉历史空 DACL；最后 `/setowner /T` 改属主。检查一条不少，只是换了顺序，没有放宽任何校验。空目录没有内容要重置、`\*` 通配符会报错，所以加了一道「有内容才重置」的判断（读不出目录按空处理，根已加固、最后的逐项核对仍兜底）。
- icacls 这三步抽成 `applyWindowsRootHardening`（纯函数，按序调用注入的 runIcacls），顺序即安全契约。`windowsAclResetArguments` 改名 `windowsAclResetContentsArguments`、目标带 `\*`。并发串行的注释改掉了「`/reset /T` 让根短暂可写」那段旧理由。
- 测试：`trusted-temp.test.ts` 新增两条（各平台都跑）——加固根必须先于重置内容、且没有一条 icacls 把根本身 `/reset`；空目录只跑加固与改属主两步。`windows-powershell-probes-smoke.mjs` 新增一条在真 Windows 上跑整套加固，证明 `\*` 通配符真能跑、且加固根那一步一返回，根就已经只给 SYSTEM/Administrators。普通权限的 Windows、Mac、Linux 不走这条路，不受影响。
