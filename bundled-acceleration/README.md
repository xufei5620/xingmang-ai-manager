# 内置加速节点

产品所有者于 2026-09-19 明确调整策略：共享线路及其连接凭据随源码提交 GitHub，供 Windows 和 macOS 打包复用，`profile.yaml` 仅包含经过白名单处理的 `proxies`，不放订阅地址、控制密码、规则和本机路径。

2026-10-21 起这里只有一条线路：自建的洛杉矶服务器（Hysteria 2，UDP 443，自签证书，SNI `bing.com`），密码是专给安装包用的共享密码，跟服务器上原有的节点账号无关。服务器只放行 ChatGPT / OpenAI 相关的几个域名，所有软件客户共用每月 1100 GiB，洛杉矶时间每月 1 日重置。客户端只把这几个域名送去线路、其余直连（`electron/acceleration-clash-config.ts` 的 `lineRoutedRules`），两边的名单要一起改。原来那 12 条买来的节点（来自 0.2.6 Windows 包）在节点商迁址后失效，已经换掉（#1352）。

`profile.sha256` 固定 YAML 原始字节的 SHA-256。更新线路时需同时更新这个文件；文件统一为 UTF-8 无 BOM、LF 换行。校验只防止误改和打包不一致，不隐藏节点凭据。

## 准备资源

平台内核、配置 JSON 和生成的五文件资源目录仍放在源码目录之外。准备对应平台的官方 Mihomo 内核、核对 SHA-256，并取得对应版本的完整 GPL v3 许可。当前发布包使用 v1.19.29，对应源码为 <https://github.com/MetaCubeX/mihomo/tree/v1.19.29>。

在仓库外创建准备配置，省略 `profilePath` 即使用本目录的节点并校验 `profile.sha256`：

```json
{
  "version": 1,
  "corePath": "C:/XingmangBuild/mihomo.exe",
  "coreSha256": "替换为已核对内核的64位SHA256"
}
```

**x64 一律取上游的 `amd64-compatible`（GOAMD64=v1）产物，不要取 `amd64`。** 后者是 v3 构建，要求 AVX/AVX2：Haswell（2013）之前的 Intel CPU 跑不了，Rosetta 2 也不提供 AVX，所以在 Apple 芯片上装 x64 包必然失败——内核一启动就退出，用户只看到「加速连接失败」。2026-09-20 的 Mac 真机测试就是栽在这里。`prepare-acceleration-bundle.cjs` 在两道哈希之后还会检查 x64 内核字节里有没有 v3 构建的运行时拒绝文案，钉错了会当场失败。

Mac 的 `corePath` 改为目标架构 Mach-O 内核的绝对路径；arm64、x64 分别准备配置及对应的 `coreSha256`。仍可显式填写 `profilePath`，指向本目录 `profile.yaml` 的绝对路径，或原有仓库外自定义 YAML。其他仓库内路径会被拒绝。

Windows 示例（路径均替换为实际路径）：

```powershell
node node_modules/typescript/bin/tsc -p tsconfig.electron.json
node scripts/stage-acceleration-bundle.cjs --config 'C:\XingmangBuild\config.json' --output 'C:\XingmangBuild\bundle-windows' --core-version v1.19.29 --source-ref v1.19.29 --license 'C:\XingmangBuild\LICENSE-mihomo.txt'
$env:XINGMANG_ACCELERATION_BUNDLE_DIR = 'C:\XingmangBuild\bundle-windows'
npm run release:build:unsigned
```

Mac 分别添加 `--platform darwin --arch arm64` 或 `--platform darwin --arch x64` 准备两份资源，随后按现有双架构入口构建：

```bash
npm run dist:mac:free -- \
  --acceleration-arm64 /absolute/bundle-arm64 \
  --acceleration-x64 /absolute/bundle-x64
```

完整签名、内核和发布校验要求见 [发布手册](../docs/RELEASING.md)。仓库不包含平台内核；普通构建和 CI 不会因为存在本 YAML 就自动开启加速，只有选择准备好的完整资源后才随安装包内置。

本机开发配置仍需显式填写 `profilePath`（可指向本文件）；正式应用运行时读取安装包中受清单保护的节点。免费时长继续为每账号在本机累计 20 分钟。

## 在线换节点（0.2.21 起）

本目录的节点也能不发版就送到客户端：改好 `profile.yaml` 和 `profile.sha256`、PR 合进 main 以后，在 Actions 里跑 `acceleration-nodes`（产品所有者批准一次），它把这份节点签名后放到更新目录。客户端只认签名对的，记在本机，下一次连接起用；读不到、签名不对、或者发过「撤回」，就用安装包里这份。**线上发过节点以后，改了这里的节点就跑一次**：不跑的话，记下过线上那份的客户端会一直用它，即使新版安装包里已经是新节点。忘了也会在发版时被拦下（`publish-release` 出包前核对线上那份，#1359）。详见 [在线换节点](../docs/GLOBAL-ACCELERATION.md#在线换节点2026-10-22)。
