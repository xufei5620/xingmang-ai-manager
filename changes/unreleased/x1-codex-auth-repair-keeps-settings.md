## 开发

- 0.2.24 深查 X-1：Codex 只坏了 auth.json、config.toml 读得懂时，首页「配置文件坏了」的「修好它」和碰上坏文件的
  「改用当前账号」以前都走 reset，把 config.toml 整份重建，客户自己加的 MCP 连接、信任过的文件夹、推理强度全没了；
  从修之前的备份找回又会把坏的 auth.json 一起放回去。新加一种写入方式 repair（config-files.ts 的
  `NativeConfigWriteMode`）：工具读不了的那份照重置重建，读得懂的那份照合并只改账号、地址、型号那几处。按官方账号修时
  官方的 config.toml 一个字不动，还接着当前账号的照「切回官方账号」只拿掉当前账号那几处。config.toml 也坏了、
  Claude Code 的 settings.json 坏了，跟原来的重置一样；配置里「重置为初始状态」照旧整份重建。
  `account:configure-managed-clis` 与 `config:switch-to-official-account` 的 mode 入参多收一个 `repair`（先备份，
  跟 reset 一样），`config:save` 的入参类型收窄成只认 merge / reset，跟它的解析一致。
