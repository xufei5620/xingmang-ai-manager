# 星芒AI管理工具发布手册

本手册只描述**当前生效**的发布流程：Windows 走无签名发布，macOS 走免费签名分发。历史签名方案（`npm run release:build`、`.github/workflows/release-build.yml` 的「CI 发布」配置、证书与固定发布者要求）已整段移到 [`docs/archive/RELEASING-signed.md`](archive/RELEASING-signed.md)，保留待 CA 证书到手，不适用于当前发布。

## 1. 当前 Windows 发布策略

产品所有者已明确（2026-09-05）：当前和后续 Windows 对外发布固定使用无签名模式，不需要代码签名证书或 `XINGMANG_SIGNING_PUBLISHER`，不得在审计或维护中重新引入这些发布前置要求。

使用现有无签名发布入口：

```powershell
npm run release:build:unsigned
```

此入口构建安装包但不上传，保留客户端自动更新；`forceCodeSigning=false`，更新配置不写入 `publisherName`。发布入口与普通 `npm run build` 都使用默认 renderer-v2 编译并生成 `dist/renderer-v2.flag`；旧界面只通过 `compile:legacy` 显式构建。普通 `npm run build` 仍是关闭自动更新的本地调试构建。

从 2026-09-18 起，`release:build:unsigned` 与签名入口共用 `scripts/run-release-build.cjs` 的同一份步骤表（审查总表 `M-01`）。无签名模式下会照常执行：

1. 发布前置检查（含「远端版本必须低于本地」）
2. `npm run typecheck`
3. 全部单测（`npm test`，三平台同一条命令；出货渲染层和画布的单测也在里面），再跑它不含的出货渲染层浏览器回归（`npm run test:v2:browser`）与旧回滚界面测试（`npm run test:ui`）
4. `npm run compile`，并确认产出 `dist/renderer-v2.flag`
5. `e2e/electron-ci-smoke.mjs` 启动冒烟
6. `e2e/onboarding-smoke.mjs` 首启向导冒烟
7. electron-builder 构建未签名安装程序
8. Electron fuse 加固校验与加固后生产程序启动
9. ASAR 篡改必须被拒
10. `latest.yml` 结构、文件大小、逐文件 SHA-512 与 blockmap 校验

无签名模式下**只跳过**第 10 步里的 Authenticode 签名主体比对，跳过原因会打印在构建日志里。只做产物校验时用 `npm run release:verify:unsigned`。

注意：无签名入口现在与签名入口一样要求输出目录不存在或为空（默认 `release-<版本号>`，可用 `XINGMANG_OUTPUT_DIR` 指定）。重跑同一版本前先把上次的产物移走或换一个新的空目录。

只想拿一份能装上试的包、不打算在本机出包时，用 GitHub Actions 上的 `package-for-testing` 工作流，步骤见 [`docs/CI-PACKAGING.md`](CI-PACKAGING.md)。那条链路出的包**带私有加速线路**（节点在 `bundled-acceleration/`，内核按 `cores.json` 钉住的哈希现场下载对账），但 macOS 侧由 runner 现场生成的一次性身份签名，只能自用验收，不能发给客户；正式发布仍按本手册在发布机上执行。

### 从 0.2.3 起的加速资源与当前节点策略

0.2.3 开始分发本机计时版：每账号在本机累计 20 分钟，TUN 尚未接入。当时节点只随本地安装包分发。产品所有者现已调整策略：发布线路的清洗后配置和 SHA-256 一并提交到 `bundled-acceleration/profile.yaml`、`bundled-acceleration/profile.sha256`，供 Windows 与 macOS 共用。具体文件与准备方式见 [内置加速节点说明](../bundled-acceleration/README.md)。

拉取源码后无需再私下传递节点文件；仍须准备对应平台的 Mihomo 内核及完整许可，并通过现有发布入口选入资源。普通构建和 CI 不会因为仓库中有 YAML 就自动获得内核或启用加速。

先编译主进程，再将资源准备到项目外的新空目录。资源准备使用的 JSON 配置保存在仓库外，包含 `version:1`、绝对 `corePath` 和 `coreSha256`；省略 `profilePath` 时，脚本读取仓库固定节点文件并校验配套 SHA-256。显式 `profilePath` 可以指向该固定文件或仓库外的自定义节点，其他仓内节点文件不接受。开发版 userData 下的 `acceleration-development.json` 仍须显式填写 `profilePath`，不使用此省略规则。下列为占位路径：

```powershell
node node_modules/typescript/bin/tsc -p tsconfig.electron.json
node scripts/stage-acceleration-bundle.cjs --config 'C:\私有配置\acceleration-development.json' --output 'C:\私有发布\0.2.3\acceleration' --core-version v1.19.29 --source-ref v1.19.29 --license 'C:\许可\LICENSE-mihomo.txt'
$env:XINGMANG_ACCELERATION_BUNDLE_DIR = 'C:\私有发布\0.2.3\acceleration'
$env:XINGMANG_OUTPUT_DIR = 'release-0.2.3'
npm run release:build:unsigned
```

脚本要求完整 GPL v3 许可并附对应源码地址；内核必须与运营者固定 SHA256 一致。只投影内联节点，不导入上游 Clash 的规则、订阅、控制接口、TUN 或脚本配置。打包前再次检查五文件白名单和资源哈希，哈希写入 ASAR 内 metadata。

实际发布前核对包内 `resources/acceleration` 与受保护 metadata 一致，再测试 packaged helper 的开始、停止及父进程断连恢复。不能用没有节点的 CI 安装包替换本地验证过的加速版本。共享节点仍可被从包中提取，本机时间也不是跨设备服务器额度；此局限已由产品所有者接受。

发布前仍需提升版本号、更新 `release-notes.md` 并完成类型检查、测试、编译和安装包验证。上传文件、修改 Cloudflare R2 或切换线上 `latest.yml` 必须获得产品所有者针对当前版本的明确发布授权，不能把构建、合并 PR 或历史授权解释为本次发布许可。

## 2. macOS 双架构加速资源

macOS 包可以携带同一份仓库内置线路，但必须显式开启：`npm run dist:mac:free` 默认**不带**线路，多传两个命令行参数才带。

不能靠设置 `XINGMANG_ACCELERATION_BUNDLE_DIR` 来开启。构建入口会先把继承来的这个变量从子进程环境里删掉（P-24 的环境清洗，避免上一次构建残留决定本次安装包携带的资源），只有下面这两个参数显式给出的目录才会被写回，并且写回前会核对该目录的资源清单确实是对应架构的 macOS 资源。

Mac 资源按架构准备（`--platform darwin --arch arm64` 或 `--arch x64`，资源清单为 version 2），每个架构一个独立的空目录，目录都必须在项目目录之外。两份 JSON 配置分别固定对应内核的路径和 SHA-256，均可省略 `profilePath` 以使用仓库节点：

```bash
node node_modules/typescript/bin/tsc -p tsconfig.electron.json
node scripts/stage-acceleration-bundle.cjs --config ~/私有配置/acceleration-arm64.json \
  --output ~/私有发布/0.2.7/acceleration-arm64 --platform darwin --arch arm64 \
  --core-version v1.19.29 --source-ref v1.19.29 --license ~/许可/LICENSE-mihomo.txt
node scripts/stage-acceleration-bundle.cjs --config ~/私有配置/acceleration-x64.json \
  --output ~/私有发布/0.2.7/acceleration-x64 --platform darwin --arch x64 \
  --core-version v1.19.29 --source-ref v1.19.29 --license ~/许可/LICENSE-mihomo.txt
```

然后带上两个架构的资源目录出包（参数值必须是绝对路径；只给一个架构会被直接拒掉，因为更新清单必须精确引用两份 ZIP）：

```bash
CSC_NAME='<身份名>' XINGMANG_MAC_SIGNING_SHA256='<64 位 SHA-256 指纹>' \
  npm run dist:mac:free -- \
  --acceleration-arm64 "$HOME/私有发布/0.2.7/acceleration-arm64" \
  --acceleration-x64 "$HOME/私有发布/0.2.7/acceleration-x64"
```

开启后构建流程与不带线路时的区别只有中间这一段：入口会**分两次**调用 electron-builder，一次 `--arm64`、一次 `--x64`，各自只看到自己架构的资源目录（Mac 资源目录按架构准备，`beforePack` 的架构核对会在不匹配的架构上直接失败，所以一次双架构构建带不了线路）。两次构建分别输出到 `release-free-<版本号>/arch-arm64` 与 `arch-x64`，随后合并到 `release-free-<版本号>` 根目录：两份 DMG、两份 ZIP、两份 blockmap 就位，`latest-mac.yml` 由两份单架构清单合并而成（以 arm64 那份为底，只替换文件列表），两个分架构子目录连同里面的解包 `.app` 一起删除。之后的产物校验、签名连续性核对、`SHA256SUMS` 生成与不带线路时完全一样。

两条路径的最后一步都一样：产物校验之前，六个文件会被改成带芯片名的发行名（`XingMang-AI-Manager-<版本号>-Apple-Silicon-arm64.*` 与 `…-Intel-x64.*`），`latest-mac.yml` 的引用同步改写。上传时保持这些名字不变——架构后缀是 electron-updater 分架构下载的依据，手工改名会让一部分 Mac 更新到另一个架构的包。

CI 上也走这条带线路的路径。`--ci-temporary-signing` 与两个加速参数在 2026-09-19 节点入仓之前互斥，之后不再互斥（见 `scripts/run-macos-free-build.cjs` 的 `parseFreeMacBuildArguments` 和 [`CI-PACKAGING.md`](CI-PACKAGING.md) 4.4）：`package-for-testing` 出的 Mac 测试包、`quality` 的 `macos-release-rehearsal` 排练（每次合进 `main` 都跑，PR 上只在动了打包相关文件时跑，名单见 `scripts/ci-change-scope.cjs`），都先在 runner 上用 `scripts/prepare-acceleration-bundle.cjs` 现场准备两个架构的资源，再带上这两个参数出包。它们由 runner 现场生成的一次性身份签名，只能自用验收，不能发给客户；正式发布的包仍按本节用发布身份出（`publish-release` 的 `macos-build` 也是带着这两个参数跑 `dist:mac:free`）。`quality` 里的 `macos-test` 与 `macos-intel` 两个作业出的包仍不带线路。

本次使用官方 Mihomo v1.19.29，内核、资源准备 JSON 和生成的五文件目录仍保存在仓库外，节点来源可使用仓库固定配置。Mac 原生网络组件通过当前构建目标编译，随安装包提供。内核保留其已固定的原始字节与上游签名，不能在代码签名阶段修改后继续使用旧哈希。

除了 `verify-macos-free-artifacts.cjs`，发布者还须检查每个最终应用的 ASAR 资源 pins、内核/节点文件哈希、原生组件路径与架构，以及组件签名。包内 `--xingmang-acceleration-worker` 入口必须能通过 IPC 完成初始化、返回仅含显示信息的线路列表并正常退出。GitHub 只收录已授权的清洗后共用节点及校验文件，不加入运营者原始 Clash 配置、订阅地址或本机控制凭据；R2 发布顺序沿用先安装包和 blockmap、后 `latest-mac.yml`。

### 2.1 拿到 Developer ID 之后要撤回的一条

当前所有 macOS 构建都走 `build/entitlements.mac.adhoc.plist`，比正式 entitlements 多授予一个
`com.apple.security.cs.disable-library-validation`。原因是 team identifier 只有苹果签发的证书才有，
自签包不关掉 library validation 就会在启动时被 dyld 杀掉（2026-09-19 的 0.2.7 测试包就是这么崩的，
原委见 [macOS 开发说明](MACOS_DEVELOPMENT.md)）。

**一旦买到 Apple 开发者账号、拿到 Developer ID Application 证书，同一个改动里要做完这几件事**：把
`electron-builder.config.cjs` 的 `macEntitlementsPrefix` 切回 `build/entitlements.mac`、更新
`scripts/macos-build-config.test.cjs` 的断言、`scripts/verify-macos-free-artifacts.cjs` 会按签名自己的
`TeamIdentifier` 自动改判允许清单（不必改），并补 notarization。

### 2.2 已发布的 macOS 签名身份不可更换

macOS 的自动更新不是本程序自己校验的：`electron-updater` 只在 Windows 上校验安装包签名
（`verifyUpdateCodeSignature` 只存在于它的 `NsisUpdater`），macOS 那一侧它把下载好的 ZIP 通过本地
代理交给系统的 Squirrel.Mac，由 Squirrel 拿**已装应用的指定要求**去验候选更新。本程序包的指定要求是
`identifier "com.xingmang.ai.manager" and certificate leaf = H"<签名证书 SHA-1>"`
（见 `scripts/verify-macos-free-artifacts.cjs` 的 `parseDesignatedRequirement`），叶证书哈希直接钉在
里面。

所以**换一张签名证书，所有已经装了正式 Mac 包的客户都会失去自动更新**：包能下载完，到安装那一步被
Squirrel 拒绝，之后发的版本也是新证书签的，一样过不了。软件也不会定时重试：交给 Squirrel 装过一次以后，
这次运行里每 3 小时的定时检查不再换包；重装只是把下好的同一个包再交给 Squirrel、不重新查更新源，装多少次都一样。所以这时
更新页和首页气泡拿掉安装按钮、只给「打开下载页」，只能每人手动重新下载安装一次。

`scripts/macos-published-signing-identity.cjs` 是已发布签名身份的台账：

- `PUBLISHED_CERTIFICATE_SHA256` 记着已发布的那张证书的 SHA-256。签名预检和产物校验都会拿本次发布
  用的证书跟它对账，不一致直接失败。登记之前（值为空）不拦，**发布 macOS 正式版之前必须登记**。
  指纹不是秘密，在发布 Mac 上读出来即可，两条命令分别粘贴执行：

  ```bash
  security find-identity -p codesigning -v
  ```

  ```bash
  security find-certificate -c "<上一条列出的身份名>" -p | openssl x509 -noout -fingerprint -sha256
  ```

  两种格式都认，大小写不限：64 位连写（`aabbcc…`）或冒号分隔（`AA:BB:CC:…`）。台账这一项还接受把命令
  输出整行粘进去（`SHA256 Fingerprint=AA:BB:…`）。**发布时的环境变量 `XINGMANG_MAC_SIGNING_SHA256`
  只接受前两种，不要带 `SHA256 Fingerprint=` 前缀。** 格式不对会在 `npm test` 或发布预检里直接报错，
  不会被当成「指纹不匹配」。

- `LEGACY_PROFILE_EXEMPT_CERTIFICATE_SHA256` 是**有意接受的一条风险**。2026-09-20 产品所有者拍板
  继续使用已发布的那张旧自签证书，不轮换，理由就是上面那条更新连续性。那张证书由 #201 之前的生成器
  签发：20 年有效期、`CA:TRUE,pathlen:0`、`keyUsage` 带 `keyCertSign`，而这三条正是现在的发布预检
  会拒绝的（P-22）。台账里登记了指纹之后，预检只对这一张证书放宽这三条，其余检查一条都不放松：
  `CRL Sign` 仍然拒、`CA:TRUE` 必须配 `pathlen:0`、EKU 仍必须只有 critical 的 codeSigning、自签名与
  身份唯一性照旧、有效期上限也只放宽到旧 profile 的 7300 天而不是取消。

  接受的风险是：这张证书在发布 Mac 上被标记为代码签名可信，而它能签发下级证书，所以拿到它 P12 的人
  可以在那台机器上继续签发链到可信锚的证书。换证书的代价是老客户全部手动重装，两害相权的结果是留着
  它。**换证书那天把这一行清空**，预检自动恢复到严格口径，同时按
  [macOS 免费自签版分发手册](MACOS_FREE_DISTRIBUTION.md) 的轮换步骤通知用户手动重装一次。

CI 的一次性临时签名身份（`--ci-temporary-signing`）与已发布身份无关，那条路径不做连续性核对，也拿不到
旧证书豁免。

## 3. 发布前置条件

依赖安全审计固定使用官方 npm registry：

```powershell
npm run audit:production
npm run audit:official
```

国内镜像不提供 npm audit API，返回 404 不能视为“无漏洞”。
CI 对生产依赖中的任意漏洞和完整依赖树中的 critical 漏洞执行阻断；`audit:official` 仍须在正式发布前人工复核全部开发依赖公告。当前 Electron 打包链的上游 high 公告若只能通过降级解决，应记录评估结果，不能用未经打包回归的强制降级换取表面上的零告警。

Electron 不能落后同一大版本的最新版超过 2 周（2026-10-18 定，#1088）。Electron 的补丁版常带 Chromium 安全修复，付款窗口、画布又都加载外部内容；而这些修复多半不会逐条进 npm 的漏洞库，上面两条审计报 0 不代表没落下（推断）。查法（两条分别执行，第二条里的 `45` 换成第一条打出来的大版本号；Mac 上把 `Select-String` 换成 `grep`）：

```powershell
node -p "require('./package-lock.json').packages['node_modules/electron'].version"
npm view electron time --json --registry=https://registry.npmjs.org/ | Select-String '"45\.'
```

第一条是锁文件里现在用的版本；第二条按发布先后列出同一大版本的每一版和发布时间（UTC）。比现在用的新的那几行里，第一行的日期离今天超过 14 天，就算落后超过 2 周：要么先升（开 PR 改 `package.json` 和锁文件，CI 跑绿再出包），要么在这一版的 `changes/unreleased/` 分片里 `## 开发` 下写一句「Electron 停在 x.y.z 没升：原因」，汇总后进 CHANGELOG。升级由开发这边做，发版的人只看一眼有没有落后。

大版本另算：Electron 只给最新的三个大版本出安全补丁，大约八周出一个新的（[时间表](https://www.electronjs.org/docs/latest/tutorial/electron-timelines)）。0.2.23 起用 45（G20，原来的 43 在 2027-01-05 停补丁），45 在 2027-04-27 停补丁，在那之前要换到更新的大版本。升 46 前先把加密存储（`safeStorage`）换成异步写法：45 里同步的那几个已经报弃用，46 删掉。升大版本照官方的破坏性改动清单逐条对代码，Mac、Windows 真机各过一遍。

- 在 `package.json` 提升版本号，版本必须高于已发布版本。
- 执行 `npm run changelog:collect`：把 `changes/unreleased/` 下的分片按 `## 用户` / `## 开发` 分别汇入 `release-notes.md` 的「未发布」段与 `CHANGELOG.md` 的 `## Unreleased` 段，并删除已汇总的分片文件。
- 定版之后、发完之前合进 main 的改动如果带了分片，要在这一版里补收：再跑一次 `changelog:collect`，把汇出来的「未发布」「## Unreleased」两段并进这一版那一节。`publish-release` 一开始就核对 `changes/unreleased/` 已经清空，还有分片就停下、什么都不动（#1086）：那些改动照样会进这次的包，不补收的话客户的更新说明里一句不提，CHANGELOG 还会把它们记到下一版。
- 汇总后把这两个标题改成本次版本号（`未发布` → `0.2.7`，`## Unreleased` → `## 0.2.7 - <日期>`），按需润色文案。`release-notes.md` 的内容会在打包时写入更新清单并显示在客户端更新页面。
- **更新页最多放 60 条。** 装完后第一次打开时那一页（和「设置 › 版本更新」里的清单）读的是包里的说明，这一版超过 60 条时，发布前置检查和 `npm run compile` 都会直接报错，不再悄悄截掉后面的（#1334：0.2.20 汇出来 84 条，后 24 条正好是几位客户报过的修复）。超了就在 `release-notes.md` 里把相近的几条合并成一条，不要把上限调大：一页太长客户也看不完。
- 客户从旧版升上来、而旧版的更新方式和新版不一样时（比如 0.2.10 没有自动更新，要客户自己点「下载更新」「重启安装」、过一次 Windows 授权窗口），把**怎么装这个更新**写在这一版说明的第一条：旧版客户端的更新页直接显示新版这份说明，这是唯一能教到他们的地方。分片文件名以 `000-` 开头，汇总时就排在最前；客服话术用同一句。
- 客户报过、这一版点名修好的问题排在它后面：分片文件名用 `001-`、`002-`……开头，数字小的在前。装完后角落那张卡片只列最前面 3 条的开头半句（第一个冒号或句号之前，长了截断），所以这几条要把「修好了什么」写在冒号前面。
- `npm run compile` 的最后一步（`scripts/bundle-release-notes.cjs`）会把 `release-notes.md` 顶上那一节写进包内的 `dist-electron/release-notes.json`，客户端更新装完后第一次启动时据此显示「已更新到 x.y.z」和这一版的改动（不走网络）。只有文件第一行等于 `package.json` 版本号时才带内容，否则写 `notes: null`、客户端不显示改动，所以**先改好标题再编译**；`verify-packaged-hardening.cjs` 会核对包里这份文件存在且版本一致。
- 发布前置检查（`npm run release:preflight`，`release:build` 的第一步）会断言 `release-notes.md` 的第一行等于 `package.json` 的版本号：忘了改标题时门禁直接失败，不会把「未发布」当成版本名发到客户端更新页（审查总表 P-14）；同一步也核对这一版不超过更新页的 60 条（#1334）。
- 使用专用 Windows 发布机，系统时间正确，依赖锁文件未被临时改写。
- 更新清单必须由对应版本的静态 R2 目录提供：`0.1.2` 及更早版本检查 `https://updates.shenfengwl.fun/xingmang-manager/latest.yml`，`0.1.3+` 检查 `https://updatesnew.shenfengwl.fun/xingmang-manager/latest.yml`。两者返回 `text/html`/官网 SPA 都属于发布阻断故障。
- Windows 主程序必须以 `asInvoker` 运行，不能在日常启动或打开 AI 工具时主动请求管理员权限。普通模式下 npm CLI 与 Grok 使用当前用户目录；NSIS 安装、主程序更新或 Node.js 系统安装只在实际执行该操作时交给 Windows 请求所需授权。打包门禁会拒绝重新引入 `RunAs` 的 CLI 启动链。
- 普通 `npm run build` 仍生成仅供本机调试的未签名安装包。按产品要求，明确设置 `XINGMANG_UNSIGNED_RELEASE=1` 或运行 `npm run release:build:unsigned` 时，未签名包会保留更新能力但不写入发布者签名校验；该模式不得与 `XINGMANG_RELEASE=1` 或 macOS 正式发布模式同时启用。
- 无签名包在 `package.json` 里带上 `xingmangUnsignedRelease: true`。2026-09-25 起这条通道也跟着「自动更新」开关走（`electron/main.ts` 的 `unsignedAutoUpdate: true`，yoyo 同意）：开着时查到新版本就在后台下，关着时只提示、用户点了才下；下好以后都不当场装，什么时候装见第 6 节。每次下完都按更新清单的 SHA-512 重新校验安装包，Windows 和 Linux 再核发布者签名（第 5 节「更新包签名」），校验值缺失或不一致一律拒绝安装。发布无签名包时必须确认 `latest.yml` 为每个安装包写出了 `sha512`，否则客户端会拒绝该次更新。
- 记下本次出包的 commit（`git rev-parse HEAD`）。发布完成后要用它打 `v<版本号>` 的附注 tag，见第 5 节。
- 每一版都分批放量：触发 publish-release 时「上传以后先推给多少」保持默认的 20，工作流自己在换更新清单之前写好，不用再先跑 service-status（2026-10-28 起，商业级差距报告 G02）。第二天中午 rollout-health 给出「放开还是停住」的建议，放开再跑一次 service-status 填 `none`。步骤见第 5 节「分批放量」。快修通道（第 5 节「热修版本」）另有规矩：客户正卡着的选 100 全量推送＋强制更新。这一版要配合服务端做旧版本不认的改动（删分组、改名这类）时，先后顺序另有规矩，见第 5 节「服务端要做旧版本不认的改动时」。

更新地址可按需通过环境变量覆盖：

```powershell
# 可选；不设置时使用正式默认地址
$env:XINGMANG_UPDATE_URL = 'https://updatesnew.shenfengwl.fun/xingmang-manager/'
```

## 4. 静态更新目录

当前静态源使用 Cloudflare R2，按版本分为两个更新桶：

```text
0.1.2 及更早：Bucket xingmang-updates，Custom domain updates.shenfengwl.fun
0.1.3+：Bucket xingmang-updates-new，Custom domain updatesnew.shenfengwl.fun
Object prefix: xingmang-manager/
```

更新目录至少包含：

```text
latest.yml
XingMang-AI-Manager-<version>-Setup.exe
XingMang-AI-Manager-<version>-Setup.exe.blockmap
```

建议响应类型：

- `latest.yml`: `application/yaml` 或 `text/yaml`
- `.exe`: `application/vnd.microsoft.portable-executable` 或 `application/octet-stream`
- `.blockmap`: `application/octet-stream`

更新目录不能配置 SPA fallback。不存在的文件应返回 404，不能返回状态 200 的官网 HTML。

## 5. 经明确授权后的原子发布

只有在当前版本已获得明确发布授权后，才执行以下步骤：

1. 保留当前线上 `latest.yml` 和对应旧版本产物，作为回滚点。
2. 先上传新安装程序和 `.blockmap`，不要覆盖 `latest.yml`。
3. 确认两个新文件已完整落盘并可通过 HTTPS 下载。
4. 最后用原子 rename/replace 发布新的 `latest.yml`。不要边上传边覆盖线上文件。
5. 运行远端完整校验：

```powershell
npm run update:verify-feed -- --platform=windows
```

该命令会下载远端 `latest.yml` 和安装程序，重新计算 SHA-512，并确认 `.blockmap` 可访问。任何失败都应立即恢复旧 `latest.yml`。

6. 使用已安装的旧版本完成一次“启动更新预检 → 后台下载并校验 → 停在「更新已下载」→ 点「重启安装」确认后安装”，确认下载完不会自己重启。另验证运行期间检查发现新版本后，用户点击下载也同样停在「更新已下载」。确认安装后的版本和用户配置均正确。

7. 给本次出货的 commit 打附注 tag 并推送，见下一节。

### 发布后：给出货的 commit 打 tag

到 0.2.6 为止仓库一个 tag 都没有。本机出的包除了发布者自己的磁盘没有任何留存，CI 出的包也只在 Actions 里保留 30 天。一旦过期，客户手上的安装包与某个 commit 之间就没有任何持久对应关系：出问题无法 bisect，也无法证明出货产物来自哪份源码。所以每次发布的最后一步固定是给出货的 commit 打 tag。

打 tag 的对象是**本次实际出包的那个 commit**，不是「发布当天的 main」——提升版本号之后、构建之前可能又合进了别的改动。出包前先记下来：

```powershell
git rev-parse HEAD
```

产物上传完成、`update:verify-feed` 通过、并且用旧版本实际验收过一次自动更新之后：

```powershell
git fetch origin
git tag -a v0.2.7 <出包的 commit> -m "0.2.7"
git push origin v0.2.7
```

约定三条：tag 名固定为 `v` 加 `package.json` 里的版本号；用附注 tag（`-a`）而不是轻量 tag，让 tag 自带打标时间和打标人；tag 推上去之后不移动、不删除。本次产物有问题时提升版本号重新发布，按第 8 节回滚，不要让同一个 tag 指向另一个 commit。

走 `publish-release` 工作流发布时这一步是自动的，但建出来的是**轻量 tag**，而且是**一开始就建好**，不是发完才打。原因是那条作业用的 `GITHUB_TOKEN` 是 GitHub App 令牌，没有、也拿不到 `workflows` 权限，GitHub 对它有一条服务端规则：要建的 ref、建 Release 时指定的提交（`target_commitish`），只要那个提交里 `.github/workflows/` 下的文件和 main 对不上就拒绝。`git push` 新 ref 撞过一次（0.2.8）；0.2.14 出包之后 main 合进了改工作流的 #774、#776，收尾时 `gh release create --target <出包的 commit>` 两次都是 HTTP 403，tag 和 Release 只能手工补。现在的做法：第一个作业 `release-tag` 用 API 把 tag 建在本次出包的 commit 上（触发那一刻它就是 main 的最新提交），出包作业都等它；收尾建 Release 时不再传 `--target`，挂到这个已有的 tag 上。上面「不移动、不删除」只有一个例外：工作流占好 tag 之后那一版没发出去就取消了，重新触发时 `release-tag` 会把它挪到新的 commit 上（见下面「触发时就占 tag」）。手工发布时仍然用附注 tag。

#### 补打历史版本的 tag

0.2.1 ~ 0.2.6 都已经发出去且没有 tag。下面是按 `package.json` 版本变更推断出的候选 commit，**仅供确认用**——如上所述，提升版本号的 commit 未必就是当时实际出包的那个。补打之前要由产品所有者逐个核对，确认不了的版本宁可不补，也不要打一个指向错误 commit 的 tag。

| 版本 | 候选 commit | 日期 | 提升版本号的提交 |
|---|---|---|---|
| 0.1.32 | `ec26b33` | 2026-09-08 | 重建 v3.1.1 桌面界面并升级至 0.1.32 (#117) |
| 0.2.1 | `6ec4cf4` | 2026-09-10 | 发布 0.2.1 双账号接入与支付公告修复 |
| 0.2.2 | `a59a845` | 2026-09-12 | 完善账号配置与用量展示并发布 0.2.2 (#121) |
| 0.2.3 | `ac7650b` | 2026-09-14 | 0.2.3 本机加速与桌面配置修复 (#122) |
| 0.2.4 | `443e559` | 2026-09-14 | add macOS game acceleration and publish 0.2.4 (#123) |
| 0.2.5 | `ccf1eab` | 2026-09-16 | 发布 0.2.5，修复 Codex 配置和退出流程 (#124) |
| 0.2.6 | `43e09af` | 2026-09-19 | 升级 0.2.6，完善客户端接入与账号稳定性 (#128) |

补打时显式写出 commit，不要用 `HEAD`：

```powershell
git tag -a v0.2.6 43e09af -m "0.2.6"
git push origin v0.2.6
```

### CI 发布

上面第 1~7 步都可以交给 `.github/workflows/publish-release.yml` 做，只有「在真机上装一遍验收」搬不走。手工路径没有作废，两条都能用。

工作流在 Actions 页面选 **publish-release**，点 Run workflow，填三项：

- **要发布的版本号**：必须与 `package.json` 完全一致，对不上直接失败（防误发）。
- **这次发布哪些平台的包**：`all`（默认，Windows、macOS、Linux）/ `both`（和原来一样，只有 Windows 与 macOS）/ `windows` / `macos` / `linux`。
- **上传以后先自动推给多少电脑**：平时保持默认的 `20`（见下面「分批放量」）；`5`、`50`、`0`（先不自动推，只给自己点「检查更新」的人）按需选；`100` 只给快修通道里客户正卡着、要强制更新的那种（见下面「热修版本」）。选了 `100`，运行页面上会有一条黄色提示，两次批准之前都看得到。

然后它会：先把这一版的 tag 占在本次出包的 commit 上（见下面「触发时就占 tag」）→ 出 Windows 包（走 `release:build:unsigned` 的完整发布门禁，带私有加速线路）→ 出 macOS 双架构包（用已发布的那张签名证书，见 2.2）→ 出 Linux 的 x64 与 arm64 两个 deb（见下面「Linux 开关」）→ **先传安装包与 blockmap → 逐字节复核能从客户会用的地址下载下来 → 写好分批放量、核对客户读得到 → 最后才覆盖 `latest.yml` / `latest-mac.yml`（以及 Linux 的两份清单）** → 每个平台各跑一次 `update:verify-feed` → 在占好的 tag 上建 GitHub Release。

这次选了 Windows 或 macOS，它的出包作业没有成功（失败、超时被取消都算），publish 作业就不跑，不会悄悄只发另一个平台、让这个平台的客户收不到这一版（#1090）。Linux 算不算数看下面的开关。

**Linux 开关。** Linux 的包每次选 `all` 或 `linux` 都会出（`linux-checks` 先在 x64 上跑一遍类型检查和全部测试，`linux-build` 两个架构各自过 `npm run release:package:linux` 的出包门禁、apt 真装、普通用户真开、卸干净），但**传不传到更新目录和 GitHub Release，看仓库变量 `XINGMANG_PUBLISH_LINUX`**：

- 不是 `true`（包括没建这个变量，现在就是没建）：publish 作业不下载 Linux 的包，客户看不到任何 Linux 的东西；Linux 两个作业红了**不代表这次发布失败**，也不挡 Windows / macOS；只选 `linux` 时 publish 作业整个跳过，不会停下来等批准。Linux 包留在那次运行的 Actions artifact（`linux-release-<架构>-<版本>`）里 14 天，可以下下来装机验收。
- 是 `true`：Linux 和别的平台一样，这次选了 Linux 而 Linux 作业没有成功（失败、超时被取消都算）就不发；两个架构的清单必须一起到，只到一个就在上传前停下。
- 打开：仓库 **Settings → Secrets and variables → Actions → Variables → New repository variable**，Name 填 `XINGMANG_PUBLISH_LINUX`，Value 填 `true`（GitHub 比较时不分大小写，`TRUE`、`True` 也算打开）。关掉就删掉它，或改成 `false` 这类不是 true 的值。第一次对外发 Linux 版之前要在真机上过一遍（`docs/LINUX.md`）。已经发过 Windows / macOS 的版本，打开开关后可以在**同一个 commit** 上再点一次 Run workflow、选 `linux` 补发。
- 打开以后发版尽量选 `all`，让三个平台停在同一个版本。只发一个平台会让别的平台落后，之后要回滚到比落后平台还新的版本时，rollback-release 会在第一步停下（某个平台线上比要退回的版本还旧，见 `docs/SERVICE-STATUS.md`）。
- Linux 两个作业不读任何 secret、不挂 release 环境，所以不会多一次批准。

这个顺序是发布正确性的一部分，不是风格问题：清单先落地，用户会在安装包还没传完时就被告知有新版本，点下载拿到 404。`scripts/publish-workflow-config.test.cjs` 把它钉住了。

**触发时就占 tag。** 第一个作业 `release-tag` 先看这一版的 tag 该建、该留还是该挪（判断逻辑在 `scripts/release-tag-plan.cjs`），再照做，出包作业都等它。它是批准之前唯一拿着写权限的作业，所以不装任何依赖，只跑 `gh`、`curl` 和仓库里几个不依赖第三方包的脚本。通常触发后一两分钟就跑完；排在前一次发布后面时，要等那一次跑完才轮到它。几种情况：

- 这个版本号已经从别的 commit 发过（GitHub 上有它的 Release，或者线上清单已经是它）、线上清单已经比它高、或者它在撤回名单里：直接停下，不出包、不用批。原来要等一个多小时出完包、批过一次，到上传前那道关才发现。同一个 commit 上重跑、补发另一个平台照常放行。
- 上一次触发占了 tag、没发出去就取消了（补进来重出包），合进修复后从 main 重新触发：tag 会挪到新的 commit 上。挪之前同样要确认那一版没有 Release、线上清单都比它旧。
- `changes/unreleased/` 里还有没汇总的分片：直接停下，不查 tag、不出包，怎么补收见第 3 节。只选 `linux` 而 Linux 开关没开时不查：main 上平时总有分片，只出包给自己装的那种运行不该被挡。
- 这一步报「GitHub 不让在 … 上建 …」：触发之后、轮到它之前，main 又合进了改工作流的提交。什么都还没发，从最新的 main 重新触发就好。
- 正式发布要从 main 触发，从别的分支或 tag 触发直接拒绝，免得 tag 占在一个发不出去的 commit 上。唯一的例外是热修分支 `hotfix/<这次的版本号>`，见下面「热修版本」。只选 `linux` 而 Linux 开关没开时不占 tag。
- 出包期间有人把 tag 删了：上传前那道关检查都过了以后先补建，再往线上传；补建不了就停下，线上什么都不改。
- 取消之后改了版本号再发，旧版本号的 tag 会留在仓库里，指向一个没发出去的 commit。它不影响发布；要清理就在仓库的 Tags 页面手动删掉。

**出包前核对在线加速节点（#1359）。** Windows 和 macOS 的出包作业在准备加速组件之前，先读一遍线上的 `acceleration-nodes.json`（客户端读的同一个地址）。线上发过在线节点、没撤回，又跟这次要装进安装包的 `bundled-acceleration/profile.yaml` 不一样，就直接停下，不出包、不用批：记下过线上那份的客户端会一直用它，新包里换的节点用不上。照提示先在 Actions 里跑一次 `acceleration-nodes`（publish 发仓库里现在的节点，或 withdraw 撤回在线节点），再从 main 重新触发。线上那份客户端不收（签名不对、格式坏了）也停下：客户端不收它也不会丢掉记下的旧节点，先跑一次 `acceleration-nodes` 的 publish 换成好的。只有线上没有这个文件（404，在线节点上线前每次都是这样）和撤回过放行，所以撤回要用 withdraw，别直接删文件。别的读不到（连不上、5xx）也停下，过几分钟重跑。

上传之前还有一道关（#493，`scripts/publish-guard.cjs`）：tag 已存在却指向别的 commit，或者线上清单已经是这个版本（或更高）而这次出的包不是同一批文件，就直接停下，线上什么都不改。所以**同一个版本号只能发一批字节**：先发 Windows、之后在同一个 commit 上补发 Mac 或 Linux 可以；某个平台已经发过这个版本，要重发就先提升版本号。仓库设置里打开 Release immutability（锁发布页）以后，发布出去的 GitHub Release 加不了、换不了文件：补发的平台照样进更新源（COS 同步开着时也进 COS），只是挂不上发布页，收尾那一步给一条黄色提示、在运行摘要里列出没挂上的文件，不会变红；要让发布页上也有，只能提升版本号再发。发布作业半路失败时，用 **Re-run failed jobs** 重跑它（用的是同一批产物，会放行）；重新点 Run workflow 会重新出包，Mac 每次出包字节都不同，如果清单已经换过去就会被这道关挡下。

**一次发布要批准两次。** 读 `.p12` 的 macOS 出包作业和上传的 publish 作业都挂 `environment: release`，运行会各停一次等你按 Approve。第一次批准之后什么都还没有对外发生，产物只躺在 Actions artifact 里——把包下下来装机验收，过了再批第二次。这两下就是本节开头说的「明确发布授权」。

**上传那一段和回滚、维护开关排队。** publish 作业与 `rollback-release`、`service-status`、`acceleration-nodes` 共用 `update-feed` 并发组（#492）：三者都是先读线上清单或状态、再写回去，同时跑会互相盖掉。所以批第二次之前如果它显示 Pending，是另一条正在写更新目录，等它跑完就轮到这里。出包那两段不在组里，不会被挡。

#### 热修版本（快修通道：上一版加一两个提交单独发）

2026-10-27 定（0.2.22：0.2.21 加上 #1405，修支付宝充值时支付窗口打不开）；同一天产品所有者把这条路定成**快修通道**（不发版、直接换掉客户电脑上的程序文件那条路，防篡改检查和签名有意挡着，不做）。什么时候用：客户正卡着一个问题，修复已经合进 main，main 上却还有一批没在真机上验过的改动，不能跟着一起出去。目标是从决定发到客户收到不超过半天：0.2.22 从定版提交（北京时间 10:20）到发出去（12:16）不到两小时，12:22 强制更新生效，13:16 教程站下载页换好。

上一版发出去以后 main 还没合过别的改动时不用切分支，直接从 main 照常发，下面四条规矩照样用。

**规矩（四条）**

- **只带这一个修复。** 一两个提交，不捎带别的，顺手的小改动也不带，留给 main 的下一版。
- **自动检查全绿。** 修复本身照常走 PR、CI 绿了才合进 main。热修分支推上去不跑 CI，但 Windows 出包门禁会把全部测试在 Windows 上重跑一遍（0.2.22 约 50 分钟），Mac 出包约 15 分钟，哪一个红了都不发。
- **真机只验出事的那条路。** 不另出测试包，第一次批准后出的包就是验收包：Windows、Mac 各装一台，只走客户卡住的那一条（0.2.22 是用支付宝充 10 元），过了再批第二次。不跑整份回归清单。
- **推多少看客户卡得多死。**
  - 客户正卡着、不升就用不了（付不了钱、装不上、打不开工具、签不出密钥这类）：**全量推送＋强制更新**（产品所有者 2026-10-27 定，0.2.22 就是这样发的）。触发时「上传以后先推给多少」选 `100`；Windows、Mac 真机都过了，再用 service-status 把「最低版本」设成这一版（下面第 6 步）。
  - 只是想早点送到、不升也还能用：「上传以后先推给多少」保持默认的 `20`，半天没有新问题就照下面「分批放量」填 `none` 全放，不设最低版本。

**步骤**

1. 从上一版的 tag 切 `hotfix/<新版本号>`，只 cherry-pick 要带的提交；版本号改成新版本号，`changelog:collect` 汇总、把两个标题改成新版本号。`release-notes.md` 这一节的第一条是「怎么装这个更新」，照抄上一版那一节的第一条，一字不差（加一条 `000-` 分片，或者汇总后直接补上都行）。main 原本要给下一版用的版本号就此让给热修，main 下一次定版用再下一个号（0.2.22 让给热修以后，main 上那一批改叫 0.2.23）。
2. **把 main 的 `.github/workflows/` 整个照搬过来**，一字不差：工作流用的令牌建不了「工作流文件和 main 对不上」的提交上的 tag（见上面「触发时就占 tag」），对不上的话 `release-tag` 那一步就停。工作流调用的脚本和钉住工作流的测试要一起搬，不然 Windows 出包门禁重跑全部测试时会红：0.2.22 搬了 12 个文件（4 个工作流、`scripts/ci-*`、`scripts/run-release-build.cjs` 和钉住它们的测试，见提交 `1ad8fe1c`），测试里钉着 main 才有、这个分支没有的功能的那几处去掉（那次去掉了视频剪辑那一个浏览器套件）。程序本身的代码一行不动。照搬以后到 `release-tag` 跑完之前，main 不要合改工作流的 PR；别的 PR 照常合，main 不用冻结。
3. 产品所有者亲手把 `hotfix/<新版本号>` 加进 **Settings → Environments → release → Deployment branches and tags**（Add deployment branch or tag rule，Ref type 选 Branch，填分支全名）。这是临时放宽「只有 main 的代码拿得到发布凭据」那道限制，所以要他亲手加、发完亲手删。`cos-sync` 环境不用加，第 7 步从 main 补传。
4. 从 `hotfix/<新版本号>` 分支点 Run workflow（Use workflow from 选这个分支），版本号填新版本号，平台选 `both`（Linux 开关打开以后选 `all`），「上传以后先推给多少」全量推的选 `100`、只放两成的保持 `20`。
5. 第一次批准以后等两个出包作业跑绿，从这次运行的 Artifacts 下载 `windows-release-<版本号>` 和 `macos-release-<版本号>`，各装一台测试电脑，只验出事的那条路，过了再批第二次。
6. 上传跑完，这次运行会显示红叉：那是发布作业后面的 `cos-sync` 被环境拒掉了，**客户已经收到**，看 publish 作业是绿的、GitHub Release 建好了就行。全量推的，Windows、Mac 真机都过了，跑 service-status，「最低版本」填新版本号，其余留空。批之前运行页面会打一条黄色提示「包出来还不满一天」，提示里只提到服务端先改了那种情况；快修通道两个平台真机都过了的，照常批。批完照「分批放量」第 2 步打开两个地址，核对 `minimumVersion` 都是新版本号。强制更新管得到谁、管不到谁见 `docs/SERVICE-STATUS.md`「强制更新（最低版本）」：0.2.11 及以后、开着窗口的电脑当场被拦去更新；窗口一直缩在托盘里的照旧停着（#1380）；0.2.10 及更早不认最低版本。
7. 补传 COS、刷新教程站：从 main 跑一次 `sync-published-manager-cos`，「标签」填 `v<新版本号>`（0.2.22 传了 43 分钟）。它跑绿以后马上跑一次教程站的 `sites`：打开 https://github.com/xufei5620/codex-tutorial-cn/actions/workflows/sites.yml → **Run workflow** → 分支选 `main` → **Run workflow**；一两分钟后打开下载页按 Ctrl+F5，Windows、Mac 的下载都应该是新版本。不点的话要等教程站下一次定时运行（一天约 3 次），这段时间新客户下到的还是上一版。
8. 收尾：产品所有者删掉第 3 步加的那条规则。往 main 提一个 PR，把这一版的 `CHANGELOG.md` 那一节并进去，删掉 main 上已经随这一版发出去的那几个分片（0.2.22 是 #1466）；main 上别的分片要是也写了这个修复（0.2.22 时还有一条写着「不会再报支付页面打开失败」），把那半句改掉（客户看得到的字，照常先给产品所有者看），免得下一版的更新说明再说一遍。`release-notes.md` 那一节这时并不进去：门禁要它的第一节是「未发布」或 `package.json` 的版本号，main 还停在上一版的版本号上。留到 main 下一次定版，`changelog:collect` 汇总出新的一节以后，把 `git show v<热修版本号>:release-notes.md` 里那一节原样插在新一节和上一版之间。

#### 分批放量（每次都做，2026-10-28 起写进发版工作流）

0.2.18 是全量发的；0.2.19 起手册要求每一版先只推两成，可那是另一条工作流（service-status），要人记着在触发发版之前先跑，0.2.20、0.2.21 都忘了，等于全量发（10-27 遗漏盘点第 1 条）。2026-10-28 起（商业级差距报告 G02）比例改成发版本身的一项输入，默认两成，写入和换清单在同一个作业里先后两步，不靠人记。快修通道例外，见上面「热修版本」。各项是什么意思、客户看到什么，见 `docs/SERVICE-STATUS.md`「分批放量」。下面拿 `0.2.23` 举例。

1. **触发 publish-release 时**，「上传以后先推给多少」保持默认的 `20: 先推给两成电脑`。不用再先跑 service-status：先跑了也会被这里选的比例换掉。两次批准照旧；运行页面上 `release-tag` 那一节写着这次推给多少，两次批准之前都看得到。
2. 第二次批准以后，发布作业先传安装包、逐字节核对，再把「分批放量」写成 `0.2.23 20`、核对客户会用的地址读到的就是这一份，最后才换更新清单（`scripts/release-rollout.cjs`）。0.2.19 起客户端每次检查更新都先重读状态文件再读清单，所以晚几秒写也来得及。写不进去、核对不上（缓存）就停在换清单之前，客户什么都没收到，过几分钟用 **Re-run failed jobs** 重跑。洛杉矶那份（`xm-direct.solov.cc`）是原样转发、不加缓存（服务端 10-17 核过），不用另核。
   - 同一次发布重跑（收尾那一步红了再跑）时，这次要发的清单线上已经是这一版，放量照线上不动：这期间可能已经有人填过 `0.2.23 0` 停住。
   - 中途取消、补进来重出包，重新触发时照样选 20，新写的直接替换旧的。
   - 同一个 commit 上补发另一个平台（比如 Linux 开关打开以后补发 Linux）：这一版还在分批，补发的平台照它走；已经全部放开了，就只对补发的平台分批（写成 `0.2.23 20@linux`），已经全放的平台不受影响。线上的分批只管别的平台（比如留着 `0.2.23 0@linux`、又补发 Mac）时，把补发的平台并进去、比例照线上的（写成 `0.2.23 0@linux|mac`），不然补发的平台不在名单里就是全放。
3. 发出去以后：自动检查更新的电脑（打开软件时、开着时每 3 小时）里大约两成会拿到 0.2.23，哪台电脑在这两成里是固定的。不受比例限制的有：自己点「检查更新」的、停在撤回名单里那个版本上的（现在是 0.2.10）、低于「最低版本」的、不读状态文件的 0.2.8 和 0.2.9。从安装教程页下载的新客户，`cos-sync` 跑完后拿到的也是 0.2.23。
4. **放量体检**：Actions 里的 **rollout-health** 每天北京时间中午 12:17 自动跑一次（也能手动点），运行摘要页第一行就是结论：「建议放开」「建议停住」「再等等」或「看不出」，后面跟着下一步怎么做和一张新版对比还在旧版的电脑的表（`scripts/rollout-health.cjs`）。
   - 比的是每天打卡（0.2.23 起才有）：同一段时间里，拿到新版的那两成和还在旧版的电脑，每 100 台·天的闪退、卡住、付款页没打开、装工具失败，加上「下好了新版、装不上」的比例。新版明显更差（多出一倍以上、每 100 台·天多 2 次以上、新版自己出过至少 3 次）就建议停住。
   - 发出去满 20 小时、新版样本够（20 台·天）、没有变差才建议放开；样本一直不够的，满 44 小时也建议放开，写明只能粗看。为什么是中午：打卡按 UTC 分天、一天只发一次，新版装上那天的问题要第二天北京时间 8 点以后开机才报上来，早上 6:17 的版本统计看不到。所以中午发的版本，第二天中午那次是第一次有结论的。
   - 每个平台单独算一格：有新版打卡的、有电脑下好了新版没装上的、这次放量管着的平台都单列，不让一个平台装不上被别的平台升上去的摊薄（R29-05，#1380 那次就是 Mac 大半停在旧版）。某个平台试着装的一台都没升上去，攒到 3 台·天就建议停住；试着装过的不到 20 台·天、看不出是个别电脑还是整个平台装不上时再等等（一台都没升上去的一直等，有升上去的满 44 小时照「样本少」放开）。放量只管某几个平台（`0.2.23 20@linux` 这类）时，样本够不够、有没有打卡按那几个平台算。
   - 0.2.23 自己放量时没有可比的对照（0.2.22 及更早不打卡），只拦明摆着坏掉的（每 100 台·天闪退 10 次以上、装不上的占两成以上），结论里会写明。从 0.2.24 起才是真正的新旧对比。
   - Sentry 上新冒出来的报错还没算进来（要先有读 Sentry 的令牌，差距报告 G06）；客服群和反馈报告照样要看，体检说放开、客服群里却有人报新问题时，以客服群为准。
5. 放开：再跑一次 **service-status**，「分批放量」填 `none`，批一次。客户端最迟 15 分钟读到，剩下的电脑下一次自动检查时拿到。用 `none` 而不是 `0.2.23 100`（两者效果一样），是为了状态文件里不留旧版本的放量设置。
   停住：体检说停住、或者拿不准，先跑 service-status 填 `0.2.23 0`（自动检查一个都不推，已经装上的不受影响），确定有问题再按第 8 节撤回或退回。修好了填回 `0.2.23 20` 接着放。

#### 服务端要做旧版本不认的改动时

2026-10-18 定（#1114）。这里说的改动，是服务端改完以后、还没升上来的客户端就签不了密钥或用不了的那类：xm 站删分组、改分组本名、改接口。0.2.19 就是服务端先删了老分组名（0.2.18 只认老名字），客户端只能发出去 12 分钟就全部放开、同时把「最低版本」抬到 0.2.19，「先给两成、观察一天」那一步等于跳过了。服务端由另一边的 AI 管，跟它约改动时把下面的先后一起说清楚。

**能提前约的：等新版本占到八成（80%）再动服务端。**

1. 先发一版改前、改后都能用的客户端（比如新旧两个分组名都认，见 `docs/SERVICE-STATUS.md`「分组对照」），照上面「分批放量」正常发、正常放开。
2. 跑 **update-feed-stats**，把这一版及以后各版本的占比加起来，Windows、Mac 都过了八成（Linux 对外发了以后也算上）再请服务端动手。Mac 一栏的数字可信。Windows 一栏数不到 0.2.18 起走洛杉矶线路的电脑，不管新版旧版（见 `docs/SERVICE-STATUS.md`「看各版本有多少人在用」），偏多偏少都说不准，所以 Windows 要请服务端照那一节的办法数一下 `xm-direct.solov.cc` 的日志，两边加起来看。
3. 服务端动手之前，用 service-status 把「最低版本」设成这一版（步骤见 `docs/SERVICE-STATUS.md`「强制更新」）。剩下不到两成的电脑下一次读状态文件（打开时，或开着的最迟 15 分钟）就被拦去更新，服务端改完时它们已经在升了。

**服务端已经先改了、旧版本不能用了：当天全部放开，但先在测试电脑上演一遍。**

旧版本已经坏了，观察一天没有意义，早一点升上来对客户只有好处。没提前约上、服务端已经改了的时候照这个做：

1. 触发发布时「上传以后先推给多少」照常保持 `20`（上面「分批放量」第 1 步）。发出去到演完这段时间里自动检查只推两成，演出问题来还停得住。
2. 照常发布，两次批准照旧。
3. 在测试电脑上演一遍旧版升新版，Windows、Mac 各一台：装着线上的上一版（GitHub 上那一版的 Release 里有安装包），在更新页自己点「检查更新」（自己点的不受放量限制），下好、重启安装，确认装完能打开、能登录、密钥签得出来、工具能用。`docs/SERVICE-STATUS.md`「在测试电脑上演一遍」那套这里用不上：那套靠只有测试电脑低于最低版本，这时设任何最低版本，真客户也一起被拦。
4. 演过没问题，跑 service-status，「分批放量」填 `none`、「最低版本」填 `<版本号>`，一次跑完，再照上面第 2 步核对两处状态文件。批准前运行页面上会有两条黄色提示（包出来不满一天、放量和最低版本同一次改），说的就是这种情况，照常批（`docs/SERVICE-STATUS.md`「批的时候会多打提示的两种情况」）。
5. 0.2.11 及以后、低于这一版的电脑都会盖上「必须更新」，关了「自动更新」的也一样。Windows 上不是管理员的账号自己装不上，要有管理员账号的人来点（第 6 节「安装」）：客服话术先备好。
6. 这一版没有观察窗口，客服群和反馈报告盯紧一些；出了问题按第 8 节，注意表里「最低版本」那一列。

#### release 环境要先配好

**这不是可选的加固。** 环境不存在时 GitHub 会在首次运行时自动建一个同名环境，而自动建出来的环境**没有任何保护规则**，上面那两次批准就都不存在了。

在仓库 **Settings → Environments → release** 里：

1. 打开 **Required reviewers**，把自己加进去。
2. **Deployment branches** 限制为 `main`。
3. 加下面九个 secret。**必须放环境级，不要放仓库级**：`workflow_dispatch` 可以指定任意分支，仓库级 secret 对任意分支可见。

| Secret | 是什么 | 谁用 |
|---|---|---|
| `CSC_NAME` | 签名身份名，即证书的 Common Name | macOS 出包 |
| `XINGMANG_MAC_SIGNING_P12_BASE64` | 发布签名证书（含私钥）导出的 `.p12`，base64 | macOS 出包 |
| `XINGMANG_MAC_SIGNING_P12_PASSWORD` | 上面那个 `.p12` 的密码 | macOS 出包 |
| `XINGMANG_MAC_SIGNING_SHA256` | 该证书的 SHA-256 指纹（不是机密，但要和上面成套；格式见 2.2） | macOS 出包 |
| `R2_ACCOUNT_ID` | R2 账号 ID，拼 S3 端点用 | 上传 |
| `R2_BUCKET` | 桶名 | 上传 |
| `R2_ACCESS_KEY_ID` | R2 凭据 | 上传 |
| `R2_SECRET_ACCESS_KEY` | R2 凭据 | 上传 |
| `XINGMANG_UPDATE_SIGNING_KEY` | 更新包签名私钥（Ed25519，PKCS8 DER 的 base64），生成方法见下面「更新包签名」 | 上传前给 Windows 和 Linux 的清单签名、回退时补签；`acceleration-nodes` 给在线加速节点签名 |

R2 凭据的**权限只给 `xingmang-manager/` 前缀的写入**，不要给整桶、不要给删除。

工作流这一边由 `scripts/workflow-secret-scope.test.cjs` 钉住（#1090）：读上表这些 secret 的作业必须挂 `environment: release`，读 COS 那两把的必须挂 `cos-sync`；仓库级只许巡检密钥 `XINGMANG_CLI_PATROL_KEY` 和访问统计令牌 `CLOUDFLARE_ANALYTICS_TOKEN` 两把（2026-10-18 定，见 `COLLABORATION.md`「一次性探测工作流」）。新加一把 secret 不登记就过不了 CI。GitHub 上的 secret 实际放在哪一级，门禁看不到，要隔一段时间在设置里核一遍：

1. **Settings → Secrets and variables → Actions**，看 **Repository secrets** 那一栏：只应该有上面那两把（或更少）。多出来的名字（`R2_`、`CSC_`、`XINGMANG_MAC_`、`XINGMANG_UPDATE_SIGNING_KEY`、`COS_`、`WIN_CSC_` 这些），先确认第 2 步的环境里有同名的一份，再把仓库级这份删掉：只挪不删等于没挪。
2. **Settings → Environments → release**：Required reviewers 里有批准的人；Deployment branches and tags 只有 `main`；Environment secrets 里有上表九把。**cos-sync**：Deployment branches and tags 只有 `main`（它不设批准人，挡住别的分支全靠这一条）；Environment secrets 里有 `COS_SECRET_ID`、`COS_SECRET_KEY`。

`.p12` 只能从钥匙串里导出、用 GitHub 的 secret 输入框直接粘，**不要经过任何聊天、工单或邮件**：那份私钥泄露等于别人能签出一个客户端会当成「同一发布者」的更新包。`XINGMANG_MAC_SIGNING_SHA256` 填的必须是 2.2 里登记的那张已发布证书的指纹，换一张证书会在签名预检那一步直接失败。

#### 更新包签名

Windows 安装包没有数字签名，`latest.yml` 又和安装包放在同一个 R2 桶里：只凭清单里的 SHA-512，拿到 R2 上传密钥的人把安装包和清单一起换掉，校验照样通过。Linux 一样：deb 交给系统安装程序以 root 装，dpkg 自己不验签（Debian、Ubuntu 默认 `no-debsig`），`latest-linux.yml`、`latest-linux-arm64.yml` 也和 deb 同放一个桶。所以发布时再加一道我们自己的签名：

- `publish` 作业在上传之前用 `XINGMANG_UPDATE_SIGNING_KEY` 给 `latest.yml` 和 Linux 两份清单的每个文件签名（`scripts/update-manifest-signature.cjs sign`），签的是「版本号 + 文件地址 + SHA-512」，签名写在该文件那一项的 `xingmangSignature` 字段里。签之前先确认这把私钥对应的公钥在客户端内置名单里（`electron/update-package-signature.ts` 的 `updateSigningPublicKeys`），对不上直接失败，免得发出一版全体新客户端都拒装的包。
- 客户端（Windows 从接上验签的 0.2.18 起，Linux 从第一次对外发的那一版起）下载完先核 SHA-512，再核这个签名；缺签名、签名不对、本机没配公钥，一律拒装。老客户端不认这个字段，照旧能升上来。线上的清单发完后各自再下载验一次签。
- 私钥只在 release 环境的 secret 里，从不进桶。所以就算 R2 上传密钥泄露，别人传上去的包也签不出客户端认的签名。
- macOS 不签：Squirrel.Mac 已经按已装应用钉住的发布证书验苹果签名，那张证书的私钥同样只在 release 环境里，再加一道挡的是同一件事。
- Linux 的 deb 本身不另签：dpkg 装包时不看包内签名，签了也没人核；更新这条路由上面的清单签名挡住，客户第一次从教程站下载的 deb 和 Windows 安装包一样，没有发布者签名可核。客户端认不认签名由 `update-package-signature.ts` 的 `shouldVerifyUpdateSignature` 决定。
- 回退（`rollback-release`）时，Windows 和 Linux 的备份清单本来就带签名的只验签；加签名之前发的老版本备份没有签名，要和 GitHub Release 上同版本的安装包（`*Setup.exe` / `*.deb`）逐字节对上才补签。Linux 从第一次对外发起就带签名，正常只走验签。GitHub Release 上找不到那个安装包时原样退回并给一条黄色提示：老客户端照样退得回去，认签名的新客户端停在被撤回的版本上。

**生成密钥（只做一次，在产品所有者自己的电脑上做）。** 私钥绝不能出现在聊天、工单、邮件或仓库里。

1. 打开 PowerShell（开始菜单搜「PowerShell」），整段粘贴下面这一行回车（要装过 Node）：

   ```
   node -e "const c=require('crypto'),fs=require('fs'),p=require('path').join(require('os').homedir(),'xingmang-update-signing-key.txt');if(fs.existsSync(p))throw new Error('已经有一把钥匙了：'+p);const k=c.generateKeyPairSync('ed25519');fs.writeFileSync(p,k.privateKey.export({type:'pkcs8',format:'der'}).toString('base64'),{flag:'wx'});console.log('私钥已存到：'+p);console.log('公钥（发给 Claude）：'+k.publicKey.export({type:'spki',format:'der'}).toString('base64'))"
   ```

   它打印两行：私钥存在哪个文件，以及一行以 `MCowBQYDK2VwAyEA` 开头的公钥。
2. 公钥那一行可以公开，发给维护的人，写进 `updateSigningPublicKeys`。
3. 在 PowerShell 里输入 `notepad $HOME\xingmang-update-signing-key.txt` 回车，记事本里 Ctrl+A、Ctrl+C 复制全部内容。
4. 仓库 **Settings → Environments → release → Environment secrets → Add environment secret**，Name 填 `XINGMANG_UPDATE_SIGNING_KEY`，Value 粘贴，点 **Add secret**。
5. 把这个文件另存一份到安全的地方（U 盘或密码管理器）。**丢了它，就再也签不出老客户端认的包**，只能先发一版带新公钥的客户端、让所有人手动重装一次。

**换钥匙**：`updateSigningPublicKeys` 可以同时放几把。先把新公钥加进去发一版，等大部分人升上去之后再把 secret 换成新私钥，最后再从名单里删掉旧公钥。在线加速节点（`docs/GLOBAL-ACCELERATION.md`「在线换节点」）用的是同一把钥匙、同一份名单，换钥匙时一起换：secret 换成新私钥以后，再跑一次 `acceleration-nodes` 用新钥匙重签线上那份。

#### 出处证明

2026-10-28 起（商业级差距报告 G21），`publish` 成功后同一次运行里的 `attest` 作业给这次真发出去的每个安装包（`*Setup.exe`、`*.dmg`、Mac 的更新 `*.zip`、`*.deb`）签一份出处证明（GitHub artifact attestation，SLSA build provenance）：「这个文件是本仓库的 `publish-release` 在哪个提交上出的」。证明存在 GitHub 上，签名记进 Sigstore 的公开透明日志。它和上面的更新包签名管的是两件事：更新包签名让客户端拒装别人换过的包；出处证明让任何人在客户端之外也能核对一个安装包是不是从这里出来的，懂行的客户、安全软件厂商问「这个 exe 是不是你们的」时拿得出凭据。

- 怎么核对（要装 GitHub CLI 并先 `gh auth login`，随便一个 GitHub 账号都行）：

  ```
  gh attestation verify XingMang-AI-Manager-0.2.23-Setup.exe --repo xufei5620/xingmang-ai-manager --signer-workflow xufei5620/xingmang-ai-manager/.github/workflows/publish-release.yml
  ```

  通过时会列出出包的提交和工作流运行；文件被改过一个字节、或者不是这条工作流出的，都会失败。签好的证明也列在 <https://github.com/xufei5620/xingmang-ai-manager/attestations>。
- `attest` 不挂环境、不读 secret、不装依赖，签证明要的 `id-token: write` 只给它一个作业（`scripts/publish-workflow-config.test.cjs` 钉住）；不多一次批准。
- 它排在最后，失败了客户照常更新：更新源和发布页这时都已经换好，只是缺一份证明。到运行页面单独重跑 `attest` 这一个作业（Re-run this job），别点 Re-run failed jobs，理由和下面的 `cos-sync` 一样。重跑会再签一份，几份都有效。
- 只给这之后发的版本签。之前发的版本没有证明，不补。

### 可选的 COS 国内文件分发同步

配置 `XINGMANG_COS_SYNC_ENABLED=true` 及受限的 COS 上传凭据后，publish 作业建好 GitHub Release，同一次运行里单独的 `cos-sync` 作业接着把本次完整发布产物同步到 COS：挂 `cos-sync` 环境，不多一次批准，最长跑 330 分钟。它失败不影响更新源和 GitHub Release；到运行页面单独重跑 `cos-sync` 这一个作业（Re-run this job），已经传好的文件不再上传。别点 Re-run failed jobs：运行里还有别的作业红着时，它会把 publish 也带着重跑、再要一次批准。`cos-sync` 只同步 publish 当时实际发了的平台，之后改了 Linux 开关再重跑也不会多出 Linux。同步没传完时这条工作流的下一次发布会排队等它；着急就在上一次运行页面点 Cancel workflow 停掉同步，新版本同步完会把 COS 的 latest 换成新版。独立工作流也可以定时同步官方 ChatGPT 安装包。环境、权限、文件校验、断网重试、全球加速与首次运行步骤见 [COS-SYNC.md](COS-SYNC.md)。

这条可选链路提供独立下载索引，尚未接入既有客户端更新源、R2 撤回与回滚；不能用它绕过本手册中的正式发布批准或 Linux 分发开关。

### Codex Desktop 国内镜像

管理工具使用 OpenAI 官方清单判断最新商店版本，并通过以下固定国内镜像读取可下载版本和 MSIX：

```text
https://codexapp.agentsmirror.com/latest/manifest
https://codexapp.agentsmirror.com/latest/win-x64
https://codexapp.agentsmirror.com/latest/win-arm64
```

首次安装恢复还会按需尝试上一版本，只有本机未检测到 `OpenAI.Codex` Appx 包时才会请求以下历史路由：

```text
https://codexapp.agentsmirror.com/previous/manifest
https://codexapp-r2.agentsmirror.com/previous/manifest
https://codexapp.agentsmirror.com/previous/win-x64
https://codexapp-r2.agentsmirror.com/previous/win-x64
https://codexapp.agentsmirror.com/previous/win-arm64
https://codexapp-r2.agentsmirror.com/previous/win-arm64
```

`previous/manifest` 必须返回与 `latest/manifest` 相同的 schema（包含版本、架构、Content-Length 和 SHA-256），不存在或不完整时客户端会跳过旧版并提示使用微软商店。已安装用户的更新流程不会请求这些历史路由，也不会降级安装。

镜像必须原样同步 OpenAI 官方文件，不能改写清单或重新打包 MSIX。服务端应为清单返回 `application/json`，为 MSIX 返回 `application/vnd.ms-appx` 或 `application/octet-stream`，不存在的文件必须返回 404，不能回退到官网 HTML。客户端会校验产品身份 `OpenAI.Codex`、版本、架构、Publisher 和 `AppxSignature.p7x`，Windows 安装器还会执行系统签名验证。

Windows 首先按当前用户调用 `Add-AppxPackage`。只有错误详情明确包含打包服务需要提权的 `0x80073D28` 时，才通过固定系统 Windows PowerShell 请求一次 UAC，并在工具行显示等待授权。通用 `0x80073CF6`、包冲突等其他错误不会触发提权。用户取消授权立即结束本次安装，不切换镜像或降级重试。

提权安装仅允许原 Windows 用户的管理员令牌；如果在 UAC 中输入另一 Windows 账号的凭据，会在安装前停止，避免给错误用户注册。跨用户管理员代装尚未实现。整个星芒主进程、CLI 和 Codex 日常启动维持原权限。安装助手在 Program Files 创建仅 SYSTEM/Administrators 可写且属于 Administrators 的临时副本，复制前校验清单长度，复制后校验 SHA-256并持有只读句柄安装，保留 Windows 系统签名验证。提权进程结束前不会提前释放安装队列；成功后仍由原调用进程回查当前用户的目标包版本。管理员安装失败可通过 Windows 应用部署事件日志排查。

镜像和官方清单查询失败时，客户端会分别保留具体错误用于诊断；下载地址固定在源码和测试中，避免运行环境把管理员安装流程重定向到未知主机。

## 6. 客户端更新行为

只有用发布模式（`XINGMANG_UNSIGNED_RELEASE=1`、`XINGMANG_MAC_FREE_RELEASE=1`）打的包开着更新，`package-for-testing` 出的测试包也开着；普通 `npm run build` 和 `XINGMANG_LOCAL_BUILD=1` 打的包关着（`xingmangLocalBuild`）。下面说的是开着时的行为，细节以 `electron/updater.ts`、`electron/auto-update-install.ts`、`electron/main.ts` 为准。

**什么时候查**

- 打开后查一次：主界面出来以后才查，不在启动页等。「启动时检查新版本」默认开，关掉的只是这次检查。8 秒没查完，界面说「网络有点慢……在后台接着查」，请求接着跑；一个字节也收不到满 45 秒才掐掉，下次检查重新发。开机自启那次，等用户第一次打开窗口、或者启动满 3 分钟再查。
- 运行期间每 3 小时查一次，不管「启动时检查新版本」开没开。已经下好一版（包括装失败）时只看更新目录上有没有比它新的：有、而且「自动更新」开着，就丢掉手里那份、在后台下新的（日志 `download.superseded`）；一样新、没查成，或者正在装、开机装正在倒数、Mac 这次已经交给 Squirrel 装过、跳框正问着装不装，都原样留着手里那份，界面不闪「正在检查」。撤回名单和分批放量照旧管这一次。以前这时干脆不查，一直开着不退出的电脑拿着最早下好的那一版，退出时、强制更新门里装上的还是它，得再升一轮。
- 状态文件（`service-status.json`，见 `docs/SERVICE-STATUS.md`）打开时读一次，之后每 15 分钟一次（维护中 5 分钟）。它把 `minimumVersion` 抬到当前版本以上时，马上补查一次；手里已经下好、却够不上新的最低版本的，也马上看一次更新目录，换下够得上的那一版（「自动更新」关着也换，换完由客户在强制更新门里点「立即更新」下）。

**下载**

- 「自动更新」默认开（只有用户关掉时才写进配置）。开着时，打开时查到的、定时查到的、打开开关时已经查到的新版本都在后台下载；关着时只提示，用户点了才下。Windows 的无签名通道 2026-09-25 起也跟这个开关走。
- 进度在首页气泡和更新页。每次下完都复核 SHA-512，对不上算下载失败。磁盘不够（安装包的 3 倍、至少 300 MB，不知道包多大按 600 MB）就不下，给「仍要下载」。
- Windows 正式包（无签名通道）复核完 SHA-512 再核发布者签名（见 5「更新包签名」），缺签名或签名不对都算下载失败，不会安装。开发态不做这一步，所以第 7 节的本地更新源不用签名。
- 分批放量只管自动检查，用户在界面上点的检查不受限；撤回名单里的版本谁都不给，下载中或下好以后被撤回的也收回。

**安装**：下好以后软件自己从不当场装（以前「下载校验完约 300ms 自动安装重启」那条已经没有了，见全面检测 Q42），装的时机只有下面几种。

- 用户在更新页点「重启安装」再点「确认重启安装」，或者从托盘菜单装，「自动更新」开没开都行。
- 「自动更新」开着：用户退出时直接装（同一个版本只自动试一次）。上次运行就下好的版本，下次打开时（开始查更新后 2 分钟内认出来）先预告 5 秒再装。开机自启、窗口一直没打开过时，Mac 上程序所在位置当前用户能写、又没连着加速，就在后台悄悄装；Windows 等用户第一次打开窗口，再预告再装；其余留到退出。
- 「自动更新」关着：打开时不装，退出时问「顺手装上吗？」（安装并退出 / 先退出，下次再装）。
- 系统关机、重启、注销时不装也不问，下次打开照常自动装。自动装过一次没装上（授权窗口点了「否」、安装程序没起来），下次打开说「新版本上次没装上」，之后只给「重新安装」，不再自动装，退出时也不再问。
- Windows 安装包装在「所有用户」目录下，每次装都弹授权窗口。账号不是管理员的电脑照样自动下载，但从不自动装、退出时也不问，更新页写明要有管理员账号的人来点；「自动更新」关着时，退出照旧问。
- Mac 交给 Squirrel.Mac 装。签名身份对不上（见 2.2）报 `UPDATE_SIGNATURE_REJECTED`，只给「打开下载页」。
- Linux 只有发布用的 deb 开着更新：下载跟「自动更新」走，但从不自动装，退出时每次都问（关掉并安装 / 先退出，下次再装）。装的时候用系统的 `/usr/bin/xdg-open` 打开下好的 .deb，用户在系统安装窗口里输开机密码，装完从应用菜单自己重新打开。别的装法只给「打开下载页」。

**必须更新**：状态文件的 `minimumVersion` 高于当前版本时，盖一层关不掉的提示，用户点一次「立即更新」就接着查、下、装，不受分批放量限制；走不通时给「打开下载页」。Linux 只在更新目录已经给了够得上最低版本的新包时才拦。

**开发态**：没打包的开发版默认关。设 `XINGMANG_UPDATE_DEV=1` 后能查、能下（读 `dev-app-update.yml`，定时检查也跑），装被主进程拒绝（「开发环境禁止执行安装更新」），打开和退出时也不装，也没有「必须更新」那层。这个变量打开不了打包时关掉的本地包；用 `XINGMANG_RELEASE` 或 `XINGMANG_MAC_FREE_RELEASE` 打包时设了它，直接报错。

## 7. 开发态更新验证

仓库内 `dev-app-update.yml` 固定指向 `http://127.0.0.1:8123/`。准备一个由 `electron-builder` 生成、版本高于当前应用的本地目录后运行：

```powershell
npm run update:serve -- --directory release --port 8123
```

另开终端：

```powershell
$env:XINGMANG_UPDATE_DEV = '1'
npm run dev
```

此模式可测试 `latest.yml` 读取、版本发现、下载进度、摘要校验和错误展示。开发态安装动作被更新服务明确禁止，不会自动重启替换调试程序，这是预期行为。端口变更时，需要同时修改 `dev-app-update.yml`。

也可单独校验本地 HTTP 更新源：

```powershell
npm run update:verify-feed -- http://127.0.0.1:8123/ --allow-local --platform=windows
```

### 旧版升新版冒烟（CI）

开发态那条只到「下载、核摘要」，装不了。从客户手上的旧版本一路升到新版本，由 GitHub Actions 的 `upgrade-smoke` 工作流在真的 Windows 和 macOS runner 上自动走一遍（商业级差距报告 G13）：

- **测哪几版**：0.2.19（强制更新的下限，客户里停得最多的一版）和最新一个正式版，各从公开 Release 下载客户拿到的那个安装包（Windows 的 `Setup.exe`、Mac 的 Apple 芯片 `.dmg`）。
- **什么时候跑**：`package-for-testing` 出完发版前那两份包以后自动接着跑，测的就是要交出去装的那两份包本身（Mac 用 Apple 芯片那份）；动到更新链路的 PR（名单在工作流的 `paths` 里）和手动点 `upgrade-smoke` 时，现出一份包来测，现出的包版本号自动垫到所有被测正式版之上，留三天就删。
- **走哪几步**（`scripts/upgrade-smoke.cjs`）：装旧版本 → 第一次打开，它自己查到新版本、下载、核 SHA-512（Windows 再核发布者签名，Mac 由 Squirrel.Mac 核代码签名）→ 强制结束 → 往设置里写几样客户自己选的外观 → 第二次打开，它自己装上新版本并重开 → 新版本记下「本次启动是更新后的第一次」（带旧、新版本号）、上次运行版本变成新版本、那几样设置原样还在、起来以后 20 秒没退出。
- **不给客户包开口子**：旧版本的更新地址写死在 `app-update.yml`，Windows 认的发布者公钥编在 `app.asar` 里，Mac 只装同一签名身份的更新。冒烟只改 runner 上**装好的那一份**：`app-update.yml` 指到本机假源；Windows 把 `app.asar` 里的公钥换成这次现生成的一把（等长替换，再把包内完整性记录和程序文件里的 asar 哈希改回一致，否则 Electron 拒绝加载），新包的 `latest.yml` 用这把私钥签，旧版本照样真核签名；Mac 把旧版本和新包都用这次现生成的签名身份重签。客户拿到的包里没有任何「换源、换钥匙」的开关。
- **Mac 的钥匙串**：程序开了 Cookie 加密，每次启动在写第一行日志之前就先从钥匙串取那把钥匙（`xingmang-ai-manager Safe Storage`）。客户的登录钥匙串按程序的代码哈希放行，升级后的新版本不在名单上，第一次打开会弹钥匙串密码框（10-27 客户遇到的就是这个框；10-28 在 runner 上对照过：钥匙留在登录钥匙串时，新版本一直停在框前，十分钟一行日志都没写）。runner 上没人点这个框，所以冒烟让旧版本把钥匙建在这次现建的临时钥匙串里：那里只按签名身份放行，新旧两版是同一个临时身份，新版本读它不弹框。第二次打开前还核一遍钥匙确实在那、没按代码哈希放行，不对就直接失败，不空等十分钟。
- **不碰线上**：旧版本第一次打开之前就断了外网，断网先自证、跑完也不撤（runner 跑完整台丢掉）。Windows 在装之前就给程序路径挂一条「只许连本机」的防火墙规则，同一条规则先套在一个 Node 上试过（本机通、外网不通）才往下走，运行中还看程序有没有本机以外的连接；Mac 把新旧两版代码里出现的域名全写进 hosts 指回本机、逐个解析确认过（系统认新 hosts 偶尔慢半拍，10-28 有一次问完一整遍都还解析到外面：没全指回本机就重写 hosts、清缓存再问一遍，最多等一分钟，还有解析到外面的才算失败），写死的 IP 用 pf 挡掉，运行中用 `lsof` 看程序和它的子进程有没有本机以外的连接，有就算失败。
- **红了看什么**：日志里有假源收到的每个请求、旧版本运行日志里更新相关的每一行、失败时 `pending-update.json` / `last-run-version.json` / `settings.json` 的内容；Mac 另有 ShipIt 自己的日志、系统日志里 ShipIt 那几行、有没有系统授权框开着、程序主线程卡在哪；程序自己的完整运行日志作为 `upgrade-smoke-*-logs-*` artifact 留七天。
- **没覆盖的**：Mac 升级后第一次打开的钥匙串密码框本身（上面说的，只能真机看）；Intel Mac、Windows 普通账号（不是管理员）的电脑、加速开着、开机自启没开窗口这几条装法；旧版本从测试包升上来以后再升下一版（只升一次）。这些仍按「测试包必看」在真机上走。

## 8. 回滚

发出去的版本有问题时，先挑用哪一招（从轻到重），每一招都在 GitHub Actions 里点一次、批一次。点哪里、填什么、客户看到什么见 `docs/SERVICE-STATUS.md`：

| 情况 | 用哪一招 | 还没升上去的人 | 已经装上的人 | 设过「最低版本」时 |
|---|---|---|---|---|
| 正在分批放量，有人报问题但还不确定 | **放量停住**：service-status「分批放量」填 `<坏版本> 0` | 自动检查不再推；自己点「检查更新」的照样拿得到 | 不受影响 | 低于最低版本的电脑不受放量限制，照样拿到坏版本。最低版本就是坏版本时，这一招谁也停不住，直接撤回 |
| 确定有问题，装上的人还能用 | **撤回**：service-status「撤回的版本」填 `<坏版本>`（填 `-<坏版本>` 撤销） | 谁都不给，正在下、已经下好没装的也收回 | 看到「这个版本有已知问题」，等修好版 | 撤回对低于最低版本的电脑同样管用。最低版本是坏版本的，同一次把「最低版本」填 `none` |
| 装上的人用不了 | **退回**：`rollback-release` 填上一个正式发过的好版本（自带撤回） | 谁都不给，0.2.8、0.2.9 也挡得住 | 看到「建议退回稳定版本」，跟着「自动更新」开关装回去 | 退回不动最低版本。最低版本是坏版本的，退回跑完再跑一次 service-status，「最低版本」填 `none` |

拿不准先撤回：几分钟生效，能原样撤销，不碍着之后再退回。不管用了哪一招，最后都发一个提升了版本号的修好版。
放量停住、撤回只有 0.2.10 及以后的客户端认；更早的只有退回（换掉更新清单）挡得住。

只有一种安装包坏了（比如只有 Intel 版的 Mac 包）：放量停住、撤回、最低版本都能在版本号后面接 `@mac-x64` 这样的平台，只管那一种，
别的平台照常（#1155 第 5 条，写法见 `docs/SERVICE-STATUS.md`「只管某几种安装包」）。只有 0.2.20 及以后的客户端分得清平台，
更早的照旧对所有平台生效：撤回、放量停住只会多拦，最低版本会把它们一起拦去更新。退回（`rollback-release`）不分平台。

最低版本为什么要跟着改成 `none`（#1114）：最低版本还指着坏版本时，低于它的电脑每次检查更新（打开时、每 3 小时）都会先盖上「必须更新」，查完发现没有能装的新版本才放行；网不好检查失败时会一直盖着，只剩「重试」「打开下载页」。退回以后，比退回目标还旧的电脑还会被这层提示逼着装上退回的那一版，提示里写的却是坏版本号（按 `electron/updater.ts` 的 `decideUpdateOffer`、`src/renderer-v2/features/app/required-update.ts` 看是这样，没在真机上演过）。修好版发出去以后还需要强制更新，再把最低版本设成修好版。

退回依赖 publish-release 在每次发布时存到 `manifests/<版本>/` 的清单备份，并在 `service-status.json` 里撤回坏版本——只有被撤回版本上的客户端才会接受更低的版本号。
另外要知道的：

- 0.2.18 起的 Windows 客户端只装带发布者签名的包（第 5 节「更新包签名」）。退回到加签名之前发的版本（0.2.15 及更早）时，`rollback-release` 拿 GitHub Release 上同版本的 `Setup.exe` 逐字节对上才补签；Release 上没有那个安装包就原样退回，这些客户端会停在被撤回的版本上等修好版。
- 安装教程页的下载（腾讯云 COS）跟着撤回名单走（#961）：撤回或回退以后点一次教程站的 `sites`（步骤见 `docs/SERVICE-STATUS.md`「坏版本回退」），新客户会拿到上一个没被撤回的版本；COS 下载清单只记最近 3 个旧版本，一个都不能给时下载页显示「准备中」。不点的话要等下一次定时运行，最长约 12 小时。
- 0.2.18 起 Windows 走直连时从 `xm-direct.solov.cc` 读更新清单和状态文件，改完要两边都核对（`docs/SERVICE-STATUS.md`「它在哪」）。

### 画布换内核期间的退回

画布在 0.2.23 换成 xingmang-canvas 内核（#1392～#1395）。原计划是让主进程先认新内核数据的那一步（#1425）早一版发出去，退回时有个能读新数据的落脚点；但 0.2.22 是紧急版（0.2.21 加 #1405），没带上它，所以 0.2.23 是新数据和新内核第一次一起发，**没有能读新内核工程的旧版本**。按代码看（没在真机上演过）：

- 0.2.22 及更早的主进程打开新内核存过的工程时报「…包含未知或敏感字段」，打不开、也就不会自动保存，文件本身不动，升到修好版照常能打开。从来没被新内核存过的老工程照常能开。
- 少数新内核存过、但恰好没用到 0.2.22 不认的字段的工程，0.2.22 能打开，它的画布会丢掉不认识的东西：设置里的数组（蒙版笔迹就在这里），中间夹着链接、`data:`、`file:`、`/Users/`、`/home/` 的字符串（便签里一句话中间带个网址，整段正文就没了），一保存就真没了。

所以 0.2.23 退回下限不动（yoyo 10-28：「修到没问题为止」），画布出了问题、管理工具还能用时，用撤回加「已知问题提示」（`docs/SERVICE-STATUS.md`），再发快修版，**不退回**。只有管理工具本身用不了才退回，并在退回说明里提醒客户：退回期间先别打开在新版画布里改过的工程，升到修好版就好，文件不会丢。

手工发布时：

- 若新 `latest.yml` 尚未发布，删除未引用的新产物即可。
- 若新 `latest.yml` 已发布但验收失败，原子恢复旧 `latest.yml`。保留新产物用于调查，不要让它继续被元数据引用。0.2.18 起 Windows 的 `latest.yml` 要带签名，私钥只在 release 环境里，手工改的清单这些客户端会拒装，要换清单请用 `rollback-release`。
- 不得用修改后的同版本安装程序覆盖线上文件。任何二进制变化都必须提升版本并重新生成 `latest.yml`。

## 9. 崩溃上报的 source map

客户端自己按 Sentry 的 envelope 格式发报错（`electron/crash-reporter.ts`，没用 `@sentry/electron`），
收在 Sentry 组织 `linfeng-aurora-inc` 的项目 `electron`（美国区）。安装包里的代码是压缩过的，
0.2.23 起每次发版把这一版的对照表（source map）传给 Sentry，后台的堆栈直接显示
`electron/*.ts`、`src/renderer-v2/*.tsx` 的行号（商业级差距报告 G06）。更早的版本没有对照表，
只能拿压缩后的行列号对着同版本的 `dist-electron` 人工找。

### 怎么对上

Sentry 只在三样都对上时用对照表，客户端和上传两边按同一套名字（`scripts/sentry-sourcemaps.test.cjs` 钉住）：

- release：`xingmang-ai-manager@<版本>`（`crashReportRelease`）。
- dist：`<平台>-<芯片>`，即 `win32-x64`、`darwin-arm64`、`darwin-x64`、`linux-x64`、`linux-arm64`（`crashReportDist`）。
- 文件地址：主进程的帧从 `…\app.asar\dist-electron\main.js` 改写成 `app:///dist-electron/main.js`，
  主窗口渲染层的从 `xingmang://app/assets/index-xxx.js` 改写成 `app:///dist/assets/index-xxx.js`
  （`resolveCrashFrameUrl`）。顺带客户的安装路径不再随报错发出去。画布窗口不上报，不在这里面。

### 怎么出、怎么传

1. `npm run compile`（`compile:runtime`）顺带出对照表：vite 用 `build.sourcemap: 'hidden'`，
   `scripts/stash-renderer-sourcemaps.cjs` 随即把 `.js.map` 搬到 `dist-sourcemaps/dist/`；
   tsc 带 `--inlineSourceMap --inlineSources`，`scripts/minify-electron.cjs` 压缩时把映射接回 `.ts`，
   写到 `dist-sourcemaps/dist-electron/`，发出去的代码里不留 `sourceMappingURL`。
   `dist-sourcemaps/` 不在 `electron-builder.config.cjs` 的 `files` 里、也不进 git，**安装包里没有任何一份对照表**。
2. 三个出包作业各把自己的 `dist-sourcemaps/` 存成工作流产物 `sourcemaps-<平台>-<版本>`，留 14 天。
3. 发版通过、`publish` 成功以后，`sentry-sourcemaps` 作业在 `sentry` 环境里下载这几份、按版本号和
   SHA-256 装 sentry-cli，跑 `scripts/sentry-sourcemaps.cjs`：建 release，按 dist 和目录逐份传（带 `--wait`，
   Sentry 处理失败当场就红），最后 finalize。只传真发出去的平台。
4. 这个作业红了不影响客户：更新源和发布页都已经换好，只是这一版的报错暂时看不到源码行。
   14 天内单独重跑这个作业（Re-run this job）即可，别用 Re-run failed jobs（理由同 `cos-sync`）。

### 令牌

- `SENTRY_AUTH_TOKEN` 放在 GitHub 的 `sentry` 环境里（Settings → Environments → `sentry`，
  只放行 `main`，不设批准，免得每次发版多批一次）。它是 Sentry 的**组织令牌**
  （Organization Settings → Auth Tokens → Create New Token），只能建 release、传对照表，读不了报错内容。
- 没放令牌时作业只提醒、不算失败，这一版就没有对照表。
- 换令牌：Sentry 里新建一个组织令牌，替换 `sentry` 环境里的值，再把旧的删掉。令牌**不要**写进任何提交的文件，
  也不要发到聊天里。`scripts/workflow-secret-scope.test.cjs` 钉住只有这个作业读它。

### 升 sentry-cli

改 `publish-release.yml` 里 `sentry-sourcemaps` 作业的 `SENTRY_CLI_VERSION` 和 `SENTRY_CLI_SHA256`。
SHA-256 按 GitHub 发布页的 `sentry-cli-Linux-x86_64` 和 npm 上 `@sentry/cli-linux-x64` 同版本包里的
那个文件各算一遍，两边一致才换。换大版本前确认 `sourcemaps upload` 还认 `--release`、`--dist`、`--url-prefix`。

### 报警和每版健康数

- Sentry → Monitors → Alerts 里有两条：Sentry 自带的「高优先级报错发邮件」，和「同一个报错一小时超过10次」
  （每来一个报错检查一次，同一个报错一小时超过 10 次就发邮件，同一个报错一天最多发一封）。免费版就有。
- 每版的闪退、卡住、星芒更新出错，每 100 台·天几次，早上的日汇总（`scripts/update-feed-stats.cjs`）
  「每版健康数」里有，最新三版各算各的；放量体检（`scripts/rollout-health.cjs`）只在放量期间比新旧版。
  这两份都出自每天打卡，不读 Sentry。新版明显偏高时去 Sentry 按 release 筛这一版新冒出来的报错。

### 验证

发版以后，`sentry-sourcemaps` 作业的运行摘要里会列出这一版每种安装包传了多少文件。要看真报错能不能对上：
在这一版的打包版上设环境变量 `XINGMANG_CRASH_REPORT_TEST=1` 启动一次，Sentry 里会多一条「崩溃上报自检」，
堆栈应显示 `electron/main.ts` 的行号；对不上时看 Sentry 在那条事件堆栈上给的 source map 提示，
多半是 release、dist 或文件地址三样里有一样没对上。
