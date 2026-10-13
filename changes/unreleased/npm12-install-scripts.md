## 开发

- npm 12 起依赖的安装脚本默认不跑，要按包放行。`buildCliInstallScriptAllowlist` 只放行离了安装脚本就装不全
  或会变样的包：Claude Code、Grok 的主程序包（钉死这次要装的版本），Gemini 的 `@github/keytar`（只拷包里带的
  预编译文件）；Gemini 的 node-pty（现场编译，Gemini 先用预编译的 `@lydell/node-pty`）和 Codex 不放行。
  全局安装走 `--allow-scripts=`；Grok 是 `npm ci`，npm 12 不许在命令行放行（EALLOWSCRIPTS），写进
  `buildCliResolutionManifest` 生成的临时 package.json 的 `allowScripts`。npm 11 及更早只认「不许跑」，
  放行名单对它们不起作用，照旧全跑，行为不变。云端照安装步骤实装：Node 26 + npm 12.2.0 / 11.20.0 下四家都装上
  并对本地假接口问通；npm 10.9.4 下 Claude、Grok，npm 9.9.4 下 Claude 照常装上（老版本不认放行写法，忽略掉）。
