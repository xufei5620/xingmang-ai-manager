## 用户

- 公司电脑或装了安全软件（会替换网页证书）的电脑上，装、更新 Claude Code 等工具，以及从星芒打开 Claude Code、Gemini CLI，都会信任这台电脑已经认可的证书，不再一上来就报证书错误。
- 仍然装不上时，提示会说清是哪一种：电脑上的 Node.js 太旧就叫你换成新版，以管理员身份打开了星芒就叫你正常打开；这台电脑本身也不认的证书，公司电脑请找网络管理员，不再只说「换一个网络」。

## 开发

- 第十七批 3：新增 `electron/system-certificate-trust.ts`。普通权限下 npm 安装（`executeNpm`）与打开工具的终端环境（Windows `sameUserTerminalEnvironment`、macOS 启动脚本放行 `NODE_USE_SYSTEM_CA`）带 `NODE_USE_SYSTEM_CA=1`，用户已设的值不覆盖；`trustedCommandEnvironment` 把 `node_use_system_ca` 加进禁止项，管理员身份时一律不带。
- 查 npm / Grok 版本元数据改走宿主注入的 `registryFetch`（main.ts 接 Chromium 的 `downloadFetch`），主进程自带的 Node fetch 不读系统证书库；管理员身份仍用 Node fetch。
- npm 报证书错误时 `withToolCertificateHint` 按 Node 版本（22.19 / 24.6 起支持该变量）与执行模式追加 `toolCertificateMessages` 的一句，渲染层新增 `toolCertOutdatedNode` / `toolCertElevated` 两类；`networkFailureMessages.tls` 与 `tlsIntercepted` 文案改为区分公司电脑与个人电脑。
