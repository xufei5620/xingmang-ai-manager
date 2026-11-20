## 用户

- Mac 上新装的 Grok 会自动连上当前账号；自己点「确认连接」连好的工具，首页那条提示也马上收起。

## 开发

- 0.2.25 总单第 17 项前一半（全面检查 I-1，Linux 沙箱实测 10-31 问题 B）：Mac、Linux 上 Grok 从 npm 装，安装包
  （1.0.77 的 `bin/postinstall.js`）装完自己写 `~/.grok/config.toml`：`[cli]` 里只有 `installer = "npm"`，npm 给 `@xai-official`
  配了源时再多一行 `npm_registry`。`tool-config-ownership.ts` 把「有文件、没密钥」一律判成 `unknown`，自动写入被
  「来源未经确认」挡下，新装的 Grok 停在「待连接」，首页挂黄条。渲染层的 `sourceFor` 早就把没登录的这种文件当「还没配置」，
  两边说法对不上。
- `config-files.ts` 新增纯函数 `isGrokInstallerOnlyConfig`：只有 `[cli]` 一张表、里面只有 `installer`（必有）和 `npm_registry`
  两个键、都是字符串才算；`inspectNativeProviderConfig` 另要求旁边没有 `auth.json`（登录过 Grok 账号，或读不出是什么），
  这时给 `grokInstallerOnly: true`。`ToolConfigOwnershipStore.read` 对 Grok 的这种文件返回 `missing`，自动写入照没配置时放行；
  合并写入只往里加，安装那一两行原样留着。多一个键（包括星芒自己写的 `auto_update`）、多一张表、有 `auth.json` 的照旧 `unknown`。
  yoyo 2026-11-21 亲手同意（原话「我同意星芒对只含 Grok 安装程序那一两行的配置文件自动连接」）。
- 用例：`tool-config-ownership.test.ts` 走一遍自动写入（旧代码上红：「来源未经确认」），客户多写一行、多一张表、登录过 Grok
  账号三种照旧被挡、文件一字不动；`config-files.test.ts` 钉住只认这一种样子，另加随机输入：多出任何表或键都不算，
  合并写入后安装那几行一个字不改。
