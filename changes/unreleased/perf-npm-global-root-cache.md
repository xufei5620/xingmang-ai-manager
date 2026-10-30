## 开发

- Mac、Linux 上找全局安装目录的 `npm root --global` 不再每次检测都起一个 node 进程（0.2.22 性能体检第 13 条，报告
  `/mnt/project-files/0.2.22-性能体检.md`）。`tool-installation.ts` 新增 `createNpmGlobalRootLookup`，服务里那一份
  （`system-service-context.ts` 的 `resolveServiceNpmGlobalRoot`）按「npm 路径 + 跑它用的 PATH」记到这次运行结束，
  重新检测、装工具、开工具、查更新都共用；同一时刻的几次查询只起一个进程。
- 什么时候重问：npm 的入口文件换过（按 realpath 后的 dev、inode、大小、修改时间、ctime 判断；升级 npm、重装 Node.js 都会换掉它，
  修改时间是解压时从安装包里带过来的，不一定变，inode 或 ctime 一定会变）、用户 `.npmrc` 改过（`npm config set prefix`）、PATH 变了
  （Mac 上改用代下的那份 Node.js）、本软件装过 Node.js（`runtime-install-service.ts` 在 finally 里作废，装到一半失败也算）。
  没问到（超时、npm 坏了）和读不出文件身份的都不记，下次照旧再问。
- 只省进程：拿到目录以后的包清单与 realpath 校验一步不少；Windows 本来就不跑 npm（直接取 npm 旁边的目录），不变。
  本软件没有卸载 Node.js 的入口，客户自己删掉的，入口文件读不到就当认不出，照旧现问。
