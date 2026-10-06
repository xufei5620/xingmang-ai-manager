## 用户

- 正在装 Git（Windows 上装好 Claude Code 后接着装的那一段也算）、WorkBuddy、Claude Desktop、OpenCode 时点「退出」，会先问一句
  「还在安装，现在退出会中断，确定退出？」，选「继续安装」就留在原处，和装命令行工具时一样。打开星芒时正好要自动装新版本的，
  碰上它们在装也先不装，留到退出时再装，不会把它们打断。

## 开发

- 第三十九批 A：`quit-blocking-tasks.ts` 的 `describeInstallTask` 多认 `runtime:git`（「正在安装 Git」）和
  `external-client:install:<客户端>`（`isExternalToolId` 认得的才算，名字取 `externalClientNames`，「正在安装 WorkBuddy」这类）。
  以前只认 `cli:install:*`、`runtime:node`、`runtime:python`、`desktop:codex:install`：装 Git（含 Windows 上装完 Claude Code
  自动接着装的那一段）和三个外部客户端时，托盘 / 菜单「退出」不拦；打开时自动装新版本拿同一个函数判 busy，也不等它们。
  认不得的 key 照旧返回 null，退出不会被拼错的 key 挡住。退出确认框的整句、`main.ts`、`auto-update-install.ts` 都没动。
- 测试：`quit-blocking-tasks.test.ts` 加 Git 和三个客户端的说法、畸形客户端 key 返回 null、Git 后面排着 WorkBuddy 时计数为 2；
  另加一条把程序里会进安装队列的每种 key 列一遍，断言退出拦截认的范围和防睡（`install-keep-awake.ts` 的
  `isKeepAwakeInstallKey`）一致。
