## 开发

- Windows 上开着 UAC 时右键「以管理员身份运行」星芒（`trusted-only`），点「打开」Claude Desktop 前有意不替它放
  Claude Code 程序（#1932 的 `not-same-user`，I8：普通权限的程序也能改那个文件夹）。以前什么都不说，客户只看到
  Claude 一直转圈；现在打开以后首页弹一句「星芒现在是以管理员身份打开的，没法替 Claude Desktop 准备程序。关掉星芒、
  直接双击打开，再点「打开」。」（yoyo 11-19 回「提示改」，不放开写入）。
- 通道 `external-clients:launch` 的返回值从 `void` 改成 `ExternalClientLaunchResult`（`external-client-contract.ts`，
  只带原因 `preparationSkipped: 'elevated'`，字由界面 `launch-notice.ts` 的 `externalLaunchWarning` 拼）；没加通道。
  放程序那一步「远程关了」「Claude 开着」两条判断挪到管理员身份判断之前，免得本来就不该放的也提醒；两条都不碰文件，
  管理员身份下照旧不读、不写 Claude 的文件夹。
