## 开发

- 决定单 D7（批次 X57，产品负责人 2026-11-11 北京回「决定单照推荐」）：Claude Desktop、WorkBuddy、OpenCode 装好或登录以后，
  从没配置过、默认密钥和型号也定得下来的，替客户自动连一次，不用再点「确认连接」→「保存并检测」。挑密钥、挑型号跟配置窗口
  打开时默认的同一套（`external-client-defaults.ts`），挑不准就不连（OpenCode 只在借 Codex 那把时连，「模型类型」才拿得准）。
  装好那次在同一个安装任务里做，进度那行用命令行工具装完时那句；连好了角落说配置窗口保存成功时那句，没连照旧说「点「确认连接」」。
  登录那次等账号密钥写完再做，界面上不说，只进运行日志（`external-client-auto-connect`）。开机恢复、切换账号不做。
- 「从没配置过」由主进程现看（`ExternalClientConnectionStatus.pristine`，不落盘）：WorkBuddy 没有 `models.json`；OpenCode 全局配置
  一个都没有、也没有它自己的 `auth.json`（在里面登过别家），也没用 `OPENCODE_CONFIG*` 另指配置；Claude Desktop 官方和第三方两个
  数据目录都不在（一次都没打开过，看不出客户有没有用自己的 Claude 账号登上，打开过的一律不碰）。开着的不碰。
- 写配置请求新增可选的 `automatic: true`（没加通道）：主进程排在写配置的队里、真要写之前再核一遍「从没配置过、没开着」，
  不是就一个字不写，免得盖掉客户这几秒里自己刚保存的那份。连接框保存成功那句挪到 `external-client-notice.ts` 共用，字没改。
  更新页「## 用户」已满 60 条，这条没占。
