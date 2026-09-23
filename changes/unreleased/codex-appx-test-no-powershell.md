## 开发

- `electron/codex-desktop-appx.test.ts` 里两条只在 Windows 上跑、要真起 PowerShell 的用例（解析两段生成脚本、未绑定 SID 的安装脚本在守卫处退出）
  改成所有平台都跑的纯文本检查：测试里按 PowerShell 自己的引号规则扫描生成的脚本，确认恶意路径只出现在单引号字面量里、括号成对、
  SID 守卫是顶层语句且排在任何文件操作之前、占位符过不了代理脚本的 SID 校验。原来 Windows runner 上冷启动 powershell.exe
  偶尔超过 30 秒用例预算，#452 首轮因此假红一次。随真跑一起删掉的还有只为它服务的临时文件、命令行长度与启动预算辅助。
