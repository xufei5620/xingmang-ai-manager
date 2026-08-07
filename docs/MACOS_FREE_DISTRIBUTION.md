# macOS 免费自签版分发

## 用户首次打开

免费自签版首次打开时，macOS 会显示来自未识别开发者的提示。这是预期的首次确认，不表示应用损坏。

1. 将“星芒AI管理工具.app”移到“应用程序”。
2. 在 Finder 中按住 Control 点按应用，或右键点按应用，选择“打开”。在确认框中再次选择“打开”。
3. 若仍被拦截，进入“系统设置 > 隐私与安全性”，在该应用的提示旁选择“仍要打开”，然后再次确认。

只在以上确认仍失败时，才在终端执行下列仅针对该应用的命令：

```bash
xattr -dr com.apple.quarantine "/Applications/星芒AI管理工具.app"
```

如果应用安装在其他位置，必须把路径改为实际的 `.app` 路径。不要关闭系统的 Gatekeeper，不要修改 SIP，也不要在客户 Mac 上安装根证书或导入发布者证书。

### 从旧版迁移与后续更新

当前使用 ad-hoc 本地包的用户，需要手动安装首个免费自签 DMG 一次。首个自签版安装并完成上述确认后，只要后续版本始终保留相同的 bundle ID `com.xingmang.ai.manager` 和同一张签名证书，应用会通过 Squirrel.Mac 自动检查、下载并重启安装更新。

免费路线不能消除首次打开警告，也不能获得 Apple notarization。需要无首次确认体验和 Apple 信任链的发布，仍应使用 Developer ID 与 notarization 的付费路线。

## 发布者操作

### 创建并保管身份

首次发布时，在受控的发布 Mac 上生成一张长期使用、加密保护并兼容 macOS Keychain 的 P12。证书名称限 1 至 64 个安全字符。P12 密码必须是 20 至 256 个可打印 ASCII 字符，并至少包含小写字母、大写字母、数字、符号中的三类；密码应由密码管理器生成并注入当前 shell，不要写进脚本或 shell 历史。生成器只能检查格式和字符类别，不能测量或保证密码的真实熵。

输出目录建议使用绝对路径，其直接父目录须已存在且路径中不能包含符号链接，目标目录须不存在或为空。若目标目录已存在，它必须由当前用户所有，且不能允许组或其他用户写入；生成器创建的新目录权限为 `0700`。

```bash
export CSC_NAME="XingMang Free Update Identity"
export XINGMANG_MAC_SIGNING_OUTPUT_DIR="/受控路径/xingmang-free-signing"
read -s "XINGMANG_MAC_SIGNING_P12_PASSWORD?P12 password: "
export XINGMANG_MAC_SIGNING_P12_PASSWORD
npm run mac:free:create-certificate
unset XINGMANG_MAC_SIGNING_P12_PASSWORD
```

生成器固定使用 macOS 系统的 `/usr/bin/openssl`，输出公开 `.cer` 和权限为 `0600` 的加密 `.p12`，不会在输出目录保留私钥文件。将 P12 保存在仓库外的受控位置，并保留受保护的离线备份。

把这份 P12 导入实际发布 Mac 的发布者钥匙串。这是仅限发布者的步骤；最终用户不得导入或信任该证书。不要在终端输出、构建日志、文档或 CI 输出中显示真实密码。

首次发布前必须在“钥匙串访问”中完成并验证以下设置：

1. 打开该证书的“信任”设置。“使用此证书时”（When using this certificate）必须保持“使用系统默认设置”，绝不能设为“始终信任”；只把“代码签名”（Code Signing）设为信任。不能把证书设为通用根信任锚。
2. 记录公开 `.cer` 的 SHA-1 和 SHA-256 指纹。运行下列不包含密码的命令；`find-identity` 输出中名称包含 `CSC_NAME` 的可选项必须只有一个，该项的引号内名称必须与 `CSC_NAME` 完全相等，SHA-1 必须与 `.cer` 的 SHA-1 完全相等。名称相同、包含关系或多个匹配项都不允许继续发布；无关的其他签名身份不受此限制。

```bash
/usr/bin/openssl x509 -in "/受控路径/xingmang-free-signing/xingmang-macos-free-signing.cer" -noout -fingerprint -sha1
/usr/bin/openssl x509 -in "/受控路径/xingmang-free-signing/xingmang-macos-free-signing.cer" -noout -fingerprint -sha256
/usr/bin/security find-identity -v -p codesigning
```

3. 完成上述人工核对后，必须成功执行下节的 `npm run dist:mac:free`。该命令中的签名预检、真实 codesign 或产物校验任一失败，都表示发布门禁未通过，不能分发产物。

P12 丢失、泄露或替换都会中断更新连续性；即使新证书名称相同也不例外。发生替换时，必须再次让用户手动迁移首个新证书版本。生产候选构建若进入 CI，只能通过受保护的 secret 提供 P12、密码和指纹，不能提交到仓库。

质量检查工作流不读取生产凭据：它只创建一次性自签身份和隔离的临时用户钥匙串来执行真实打包门禁。私钥探针和 electron-builder 自定义签名器都会同时固定证书 SHA-1 与临时钥匙串绝对路径。`codesign` 只通过用户钥匙串搜索列表解析签名身份，仅传 `--keychain` 不足以让它看到隔离钥匙串，因此流程会先读取当前用户搜索列表，把临时钥匙串前置进去，并在清理阶段先按原样还原该列表、再删除临时钥匙串；这项改动只作用于用户域，不会存活到本次构建之外。流程不写入 Trust Settings、系统钥匙串或管理员域，不使用 `sudo`，不会触发管理员密码框。完成或失败后，流程都会删除临时钥匙串、证书与构建产物；这些产物不能用于发布。

### 构建与本地校验

免费发布必须显式提供固定身份名称和固定证书 SHA-256：

```bash
CSC_NAME="已导入的免费发布签名身份" \
XINGMANG_MAC_SIGNING_SHA256="记录的 64 位 SHA-256 指纹" \
npm run dist:mac:free
```

runner 会只为 electron-builder 子进程自动启用免费发布模式，调用者不需要设置该模式变量。该命令先执行发布身份预检，再生成 arm64 与 x64 各一份 DMG 和 ZIP，以及两份 ZIP blockmap、`latest-mac.yml` 和 `SHA256SUMS`。公开安装库存必须精确为两份 DMG 加两份 ZIP；自动更新清单必须只精确引用两份 ZIP；顶层 blockmap 必须只包含两份 ZIP blockmap；`SHA256SUMS` 必须覆盖这六个文件。runner 还会校验严格的 codesign 结果、固定证书指纹及 blockmap 格式。它使用 `--publish never`，只构建和验证本地产物，绝不会上传文件。

### 发布到更新服务器

自动更新只在更新服务器完整提供 macOS 清单和它引用的文件后才能工作。如果服务器缺少 `latest-mac.yml`，免费包仍然会启用更新功能，但检查结果会是“更新失败”，而不是“本地开发包不检查更新”。

1. 先上传新版本的 arm64/x64 ZIP、DMG 和两份 ZIP blockmap；`latest-mac.yml` 只引用两份 ZIP，不引用手动安装用的 DMG。
2. 确认这些文件可以通过 HTTPS 直接下载，不能跳转，也不能返回网站的 HTML 备用页。
3. 在所有版本文件都就绪后，最后以原子替换方式发布 `latest-mac.yml`，避免用户读到半更新状态。
4. 发布后执行 `npm run update:verify-feed -- --platform=macos`，只有 macOS 双架构元数据、所有引用文件的大小与 SHA-512，以及两份 ZIP blockmap 都验证通过才能对外通知更新。需要联合检查两条通道时，再执行不带 `--platform` 的默认双平台校验。

`SHA256SUMS` 可与安装包一起提供给用户手动校验，但不能代替 `latest-mac.yml` 或应用签名连续性。

`SHA256SUMS` 用于确认下载文件与发布时的字节内容一致，但它本身不能建立首次安装信任。首次人工确认完成后，Squirrel.Mac 会把候选更新与当前应用的固定证书 requirement 连续性进行比对；这比仅比较可从任意渠道获得的校验和更强，但依赖同一张证书和同一 bundle ID 始终保留。

发布前还应阅读 [macOS 开发与打包](MACOS_DEVELOPMENT.md)，了解本地 ad-hoc、免费自签和 Developer ID 三种模式的边界。
