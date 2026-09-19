# 星芒AI管理工具签名发布流程（历史归档，已停用）

> **这份文档不是当前的发布流程。** 产品所有者已明确（2026-09-05）：当前和后续 Windows 对外发布固定使用无签名模式，`npm run release:build` 与 `.github/workflows/release-build.yml` 都不用于当前发布。当前生效的流程见 [发布手册](../RELEASING.md)。
>
> 这里保留的是 CA 证书到手之前做好的整套签名方案，等证书到位可以直接照着恢复。文中的证书、固定发布者和 DN/CN 要求**不适用于**当前的无签名发布，不得在审计或维护中把它们当成发布前置要求重新引入。
>
> `scripts/verify-release-environment.cjs` 与 `scripts/verify-release-artifacts.cjs` 现在两种模式共用（无签名模式只跳过 Authenticode 签名主体比对），不再是签名专用。

## 1. 签名专用的发布前置条件

除本节列出的条目外，发布前置条件与当前流程相同，见发布手册的「发布前置条件」一节。

- 正式发布必须使用 Authenticode 签名；没有证书、固定发布者或干净 Windows 验收机时，发布预检会直接失败。
- 所有 Windows 包的 `app-update.yml` 都写入预期发布者，防止 `electron-updater` 因缺少 `publisherName` 跳过验证。客户端使用受保护系统目录中的 PowerShell 严格核对下载文件的 `Valid` 状态、返回路径和发布者 DN/CN；PowerShell 缺失、命令失败、输出无法解析或任一字段不匹配均拒绝更新。
- 正式发布前配置证书路径和固定发布者，例如：

```powershell
$env:WIN_CSC_LINK = 'C:\secrets\xingmang-signing.p12'
$env:CSC_KEY_PASSWORD = '<证书密码>'
$env:XINGMANG_SIGNING_PUBLISHER = '绍兴星芒文化传媒有限责任公司'
```

## 2. 构建与本地门禁

```powershell
npm run release:build
```

默认输出目录为 `release-<package version>`。脚本在联网预检、测试或构建前要求目标目录不存在或为空；检测到旧安装包、旧 `latest.yml` 或任何其他文件时会立即失败，并且绝不自动删除现有产物。需要保留同版本的多次候选构建时，显式指定项目目录内新的空目录：

```powershell
$env:XINGMANG_OUTPUT_DIR = 'release-0.1.4-candidate-2'
npm run release:build
```

执行顺序固定为：

1. 检查 HTTPS 更新 URL 和远端静态路由。
2. 执行 TypeScript 类型检查、全部单元测试和前端/主进程编译。
3. 运行主界面与首次启动向导的开发态 Electron 冒烟测试。
4. 以 `XINGMANG_RELEASE=1` 和关闭证书自动发现的环境运行 `electron-builder --publish never`，使用显式证书生成已签名 NSIS 安装程序。
5. 校验打包程序的 Electron fuse、`app.asar` 和渲染页/IPC 启动状态，并确认远程调试参数被拒绝。
6. 复制并篡改 `app.asar`，确认打包程序因嵌入式 ASAR 完整性校验而拒绝启动。
7. 校验当前空发布目录中生成的 `latest.yml` 结构、每个本地文件的大小与 SHA-512，以及主安装程序 `.blockmap`。
8. 使用 Windows `Get-AuthenticodeSignature` 确认安装程序状态为 `Valid`，并严格匹配 `XINGMANG_SIGNING_PUBLISHER`。

任一步失败都不得继续上传。

全部门禁通过也只表示候选产物具备发布条件，不会自动上传，且不构成发布授权。

## 2.1 CI 发布（GitHub Actions，2026-08-12 起）

老板决定把出包这一步搬到 CI。`.github/workflows/release-build.yml` 在 `windows-latest` 上跑的就是上面第 2 节那条完全相同的链路（它直接调用 `npm run release:build`），只是证书来自仓库 Secrets 而不是发布机磁盘。

**一次性配置分两步：先建受保护环境，再把 secret 配进那个环境。**

**第一步：建 `release` 环境**（仓库 Settings → Environments → New environment，名字必须是 `release`）：

- 勾上 **Required reviewers**，把自己加进去。以后每次跑 `release-build` 都要点一次同意，跑之前构建会停在等待审批。
- **Deployment branches and tags** 选 **Selected branches and tags**，只加 `main`。

⚠️ **这一步不能省，也不能靠 workflow 自己长出来。** `release-build.yml` 里写了 `environment: release`，但环境不存在时 GitHub 会在首次运行时**自动创建一个没有任何保护规则的同名环境**——看上去一切正常，实际上什么都没挡住。建完之后回环境页面确认两条规则都在。

为什么要这么做：`release-build` 是 `workflow_dispatch`，GitHub 允许触发时指定**任意 ref**，跑的是那个 ref 上的 workflow 文件。只要签名 secret 还留在仓库级，任何有 write 权限的人推一个分支、在里面加一行把证书 base64 打印出来，再 dispatch 到那个分支，就能把签名证书和密码整个拿走。环境保护是唯一能挡住这条路的东西。

**第二步：在 `release` 环境里**（不是仓库级 Secrets）配三个 secret：

| Secret 名 | 内容 |
|---|---|
| `WIN_CSC_LINK_BASE64` | 代码签名证书 `.p12` 的 **base64 文本**（electron-builder 直接接受 base64，证书不落盘） |
| `WIN_CSC_KEY_PASSWORD` | 该证书的密码 |
| `XINGMANG_SIGNING_PUBLISHER` | 固定发布者名，例如 `绍兴星芒文化传媒有限责任公司` |

如果这三个 secret 之前配在仓库级（Settings → Secrets and variables → Actions），**挪完之后要把仓库级那三份删掉**，否则等于没挪。

把 `.p12` 转成 base64（在你自己的机器上做，不要在任何共享环境里做）：

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes('C:\secrets\xingmang-signing.p12')) | Set-Clipboard
```

**每次发布**：Actions → `release-build` → Run workflow，在 `confirm_version` 里填 `package.json` 里的版本号（填错会在第一步就失败，这是防误发的闸）。跑完在 run 页面下载 artifact，里面是 `Setup.exe` + `.blockmap` + `latest.yml` 三件套，日志里有每个文件的 SHA-256，上传到对象存储后可逐个比对。

**这条 workflow 永远不会上传到更新服务器**，也没有配置任何对象存储凭据。上传仍按[发布手册](../RELEASING.md)的「经明确授权后的原子发布」一节由人执行——发布手册要求每次发布都要产品所有者针对当前版本明确授权，把上传自动化等于取消那道授权。

两点与本机发布的差异要知道：

- **画布**：云端没有兄弟仓 `xingmang-canvas` 的 v1 产物，所以 CI 会现场构建仓内的 `canvas-v2` 打进包里。也就是说 **CI 出的正式包带的是 v2 画布**，与测试包一致。若某次发布要改回 v1，只能在本机构建。
- **版本必须高于线上**：发布前置检查会拉取线上 `latest.yml` 比对，版本没提升会直接失败——这是好事，能拦住忘记改版本号的发布。

### 还没拿到 CA 证书时：用自签名证书先验证更新链路

默认本地构建仍把"能更新"和"已签名发布"隔离；只有显式的 `XINGMANG_UNSIGNED_RELEASE=1` 测试/发布模式才会把 `extraMetadata.xingmangLocalBuild` 关闭，从而允许未签名包检查和安装更新。

在真证书到手之前，可以用**自己生成的自签名证书**把整条链路真跑一遍——签名、写 `publisherName`、更新器启用、客户端下载后校验签名，全部真实执行，只是这张证书只有你自己的机器认。真证书到手后换掉 Secret 即可，代码一个字不用改。

**1. 在你自己的 Windows 机器上生成证书**（私钥不要离开这台机器以外的地方）：

```powershell
$cert = New-SelfSignedCertificate `
  -Type CodeSigningCert `
  -Subject 'CN=绍兴星芒文化传媒有限责任公司' `
  -CertStoreLocation Cert:\CurrentUser\My `
  -NotAfter (Get-Date).AddYears(2) `
  -KeyExportPolicy Exportable

$password = ConvertTo-SecureString '自己设一个密码' -AsPlainText -Force
Export-PfxCertificate -Cert $cert -FilePath "$HOME\xingmang-test-signing.pfx" -Password $password | Out-Null
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$HOME\xingmang-test-signing.pfx")) | Set-Clipboard
```

`Subject` 里的 CN **必须**与 `XINGMANG_SIGNING_PUBLISHER` 完全一致，否则产物校验会因发布者不匹配而失败。

**2. 配置 Secrets**：把剪贴板里的 base64 填进 `WIN_CSC_LINK_BASE64`，密码填 `WIN_CSC_KEY_PASSWORD`，发布者填 `XINGMANG_SIGNING_PUBLISHER`。仍然配在上面那个 `release` 环境里。

  **3. 触发构建**：Actions → `release-build` → Run workflow，勾上 `test_signing`，并在 `update_url` 填一个**与正式源不同的测试路径**，例如 `https://updatesnew.shenfengwl.fun/xingmang-manager/beta/`。这一项是强制的：自签名产物一旦进了正式更新源，老客户的机器不认这张证书会拒绝更新（失败方向是安全的），新装用户则会看到未知发布者警告。

**4. 在测试机上验证更新链路**：把三件套传到那个 beta 路径 → 在虚拟机装上这一版 → 提升 `package.json` 版本号再跑一次构建 → 传新的三件套（顺序仍是先传包与 blockmap、最后覆盖 `latest.yml`）→ 在已装的旧版本里点「检查更新」，应能发现、下载、重启安装成功。

**只有勾了 `test_signing` 的构建**才会把这张证书导进 runner 的「受信任的根证书颁发机构」，好让发布门禁要求的 `Get-AuthenticodeSignature = Valid` 能够成立。正式构建**不做**这一步：`Valid` 本身就建立在链信任上，先把证书塞进根存储再去断言它有效，等于自己给自己判卷——中间 CA 没打进 `.p12`、交叉证书缺失、时间戳服务当时不可用，这些只会在一台干净 Windows 上暴露的问题就全被盖住了，CI 全绿而客户装出来是「未知发布者」。所以正式证书第一次上 CI 时，要做好它可能直接在产物校验这一关失败的准备，那正是它该失败的地方。

**5. 安装时的提示**：自签名证书未被 Windows 信任，安装时仍会有 SmartScreen 警告。若想在测试机上消除，把 `.pfx` 里的证书导入该机器的「受信任的根证书颁发机构」；**不要**在任何客户机器上这么做。

自签名产物的 artifact 名字会带 `TEST-SIGNED-DO-NOT-PUBLISH` 前缀，别把它传到正式更新源。
