## 用户

- 装工具时如果中途关了星芒、电脑断电或重启，没装完的下载会一直占着 C 盘。现在星芒打开一会儿后、以及每次装好工具后，会在后台自动清掉这些没用的下载，不用你点，也不会动你自己的文件和已经装好的工具。

## 开发

- 新增 `electron/install-leftovers.ts`：只按固定前缀 + mkdtemp 6 位随机串认星芒自己建的安装临时目录（npm 事务、Grok、Codex 桌面端、Node.js、Git、Python、WorkBuddy），超过 6 小时、是普通目录且 realpath 不变才删；Windows 普通权限只扫用户临时目录，按管理员处理时只扫 ProgramData 的 InstallerCache，绝不在用户可写处做管理员级删除（同 I8）。
- `SystemService.cleanupInstallLeftovers` 排进 InstallationQueue（I11），开机安静期结束后再等 2 分钟跑一次、每次 CLI 装好后跑一次；只记 runtime.jsonl，不弹提示。删除实现由 main.ts 注入，缺省不清，单测不碰开发机临时目录。
- 候选第十七批 7 的前提有一处与代码不符：npm 下载缓存本来就是每次安装各一份、装完在 finally 里删（system-service.ts 安装收尾），真正会越积越多的是安装被打断或删除失败时留下的整份临时目录，所以没有加「清理」按钮和新 IPC 通道。
