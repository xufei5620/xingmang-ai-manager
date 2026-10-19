## 开发

- 拆 `system-service.ts`（#1070 第 2 步，中间一段）：装命令行工具要用、别的簇也要用的几个顶层小工具先搬成独立小文件，后面把安装那一大段搬进 `cli-install-service.ts` 时，它和首页检测、卸载就不用互相 import。新文件 `electron/npm-registry.ts`（两个 npm 源的地址、按网络区域谁先谁后、查询地址怎么拼、查询超时和响应体上限）、`electron/npm-command-failure.ts`（npm 命令没成功时给客户看的那句、超时的说法、换源也没用的几种）；`grokInstallStrategyFor` 搬进 `platform-capabilities.ts`，Mac 上核 Grok 签名用的 `buildDarwinTrustedVerificationRunner` 搬进 `system-service-context.ts`，读已装包版本号的 `readPackageManifestVersion` 搬进 `cli-native-package.ts`。
- 搬运用脚本整段复制，搬前搬后逐段比对；只改了五个原本不导出、现在要跨文件用的名字前面加 `export`，以及两处注释里的文件名。`system-service.ts` 照旧导出原来导出的那几个，测试和别处的 import 不用动。`buildDarwinTrustedVerificationRunner`（固定用 `trustedCommandEnvironment` 跑 codesign）只搬不改。
- 测试：`readPackageManifestVersion` 原来不导出、没有单测，补了三条（读出精确版本并去空白、不是精确版本或不是对象时答 null、文件不在或超过 256 KB 时答 null）；其余照旧由 `system-service.test.ts` 经原来的导出覆盖。
