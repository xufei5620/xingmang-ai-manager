# macOS 真机验收 Runbook（免费自签分发）

> 验收对象：`npm run dist:mac:free` 出的**免费自签** DMG / ZIP。
> 这一份里的每一步都**只能在发布 Mac 上做**：云沙箱是 Linux；CI 的 macOS 作业虽然会用一次性临时身份
> 真的打一次包并校验产物，但它**从来没有启动过应用**，也不跑本文的任何一条。
> 权威口径在 [`MACOS_FREE_DISTRIBUTION.md`](MACOS_FREE_DISTRIBUTION.md)（分发与证书）和
> [`RELEASING.md`](RELEASING.md)（发布流程）；本文只是把要人工动手的部分按顺序列出来。
>
> 上一版（2026-08-09 的“第三轮”）验的是 grok agent 链自愈那三点，已移到第 5 节作为可选回归。

---

## 0. 出包前：签名身份

免费路线用一张自己生成的证书，**没有 Apple 证书、也拿不到 notarization**，首次打开必然有系统提示。
这不是缺陷，见 `MACOS_FREE_DISTRIBUTION.md` 的“用户首次打开”。

首次发布才需要生成证书（`npm run mac:free:create-certificate`），之后一直用同一张：
**换证书会中断 Squirrel.Mac 的更新连续性，所有老用户都要手动重装一次**，只有临近到期或私钥泄露才换。

每次出包前核对一次身份（`find-identity` 里名称包含 `CSC_NAME` 的可选项**必须只有一个**，
且引号内名称与 `CSC_NAME` 完全相等）：

```bash
/usr/bin/security find-identity -v -p codesigning
/usr/bin/openssl x509 -in '<证书路径>/xingmang-macos-free-signing.cer' -noout -fingerprint -sha1
/usr/bin/openssl x509 -in '<证书路径>/xingmang-macos-free-signing.cer' -noout -fingerprint -sha256
```

**算通过**：只有一个匹配项，且它的 SHA-1 与 `.cer` 的 SHA-1 完全相等；SHA-256 是出包时要传给
`XINGMANG_MAC_SIGNING_SHA256` 的那一串。
**不通过**：多个同名项或名称只是包含关系，**不要继续发布**，先清理钥匙串。

> 手上如果还留着早期生成器签发的证书（20 年期、`CA:TRUE`、带 `keyCertSign`），必须重新生成再发。
> 现在的生成器签发的是 10 年期、`CA:FALSE` 的终端证书，签名预检会按这几条硬校验。

---

## 1. 出包

```bash
CSC_NAME='<身份名>' XINGMANG_MAC_SIGNING_SHA256='<64 位 SHA-256 指纹>' npm run dist:mac:free
```

这条命令自带类型检查、全部单测、编译、签名预检、双架构打包和产物校验，不需要手工补跑。
输出目录默认是 `release-free-<版本号>`，**必须不存在或为空**；构建失败时脚本会自己把本次创建的目录删掉。

这样出的包**不带**加速线路。要带线路得多传两个参数，见第 3 节。

**算通过**：命令以 0 退出，输出目录里精确是这 8 个文件——两个架构各一份 DMG 和 ZIP、
两份 ZIP blockmap、`latest-mac.yml`、`SHA256SUMS`。多一个少一个都会被产物校验直接拒掉。
六个产物的文件名带芯片名：`…-Apple-Silicon-arm64.…` 和 `…-Intel-x64.…`，名字里还留着
`-arm64` / `-x64` 后缀是给自动更新和校验认的，别手工改名。

**不通过**：日志会写明是哪一步。把那一段原样发我。

---

## 2. 必须过的验收点

按顺序做，每项记 PASS / FAIL。发现问题就停下来记录，不要接着往下试。

### 2.1 包能不能启动（最可能打回来的一条）

装一次 1 节出的 DMG 并**启动它**。

**为什么单列**：**2026-09-19 这一条已经发生过一次**，而且产物校验全绿——签名本身完全有效。当时走的是
正式 entitlements（`build/entitlements.mac.plist`），library validation 开着，它要求进程与它加载的每
一个库带同一个 team identifier；而 team identifier 只有苹果签发的证书才有，自签证书永远没有。装上去的
包于是在加载自己的 Electron 框架时被 dyld 杀掉，弹的是「应用因为出现问题而无法打开」，不是 Gatekeeper
提示。当天先试过给证书主题加 `OU`，赌 codesign 会把它记成 team identifier，实测无效（新包仍是
`TeamIdentifier=not set`）。最终修法是所有自签构建改用 `build/entitlements.mac.adhoc.plist`，授予
`com.apple.security.cs.disable-library-validation`；拿到 Developer ID 之后撤回。

现在 CI 已经会真的启动一次打包后的 `.app`（`e2e/macos-launch-smoke.mjs`），这一条仍然要人工做一遍：
CI 跑的是临时身份签出的包，且它只看进程有没有活下来。

**算通过**：应用正常起来，进到登录界面。
**不通过**：先别发 macOS 包，告诉我，并把崩溃报告里 `Termination Reason` 那几行一起发过来。

### 2.2 首次打开的确认流程

用一台**没装过**本应用的 Mac（或新用户账户）走一遍客户会走的路：

- [ ] 把 `.app` 拖进“应用程序”
- [ ] 直接双击时出现“来自未识别的开发者”提示（**这是预期的**，不是缺陷）
- [ ] 按住 Control 点按 →“打开”→ 再次“打开”，能起来
- [ ] 或在“系统设置 > 隐私与安全性”里“仍要打开”，能起来

**不要**为了绕过它去关 Gatekeeper、改 SIP，或让客户导入证书。`xattr -dr com.apple.quarantine` 只在上面两条都失败时才用，
且必须指向那一个 `.app` 的实际路径。

### 2.3 构建脚本的三条真机行为（PR #189）

这三条在沙箱和 CI 里都只跑过 mock，`/usr/bin/security` 的真实行为从没验过。

1. **签名打包走得通**：1 节那条命令本身跑通，就说明口令改走 `security -i` 的 stdin 之后签名链路是好的。
   *不通过的最小回退*：把 `resolveMacosSecurityCommand` 的 secrets 分支去掉退回 argv——**先告诉我，别自己改**。
2. **Ctrl-C 后不留残留**：构建跑一半按 Ctrl-C，然后 `security list-keychains -d user`。
   **算通过**：login 钥匙串还在，没有多出指向 `/var/folders` 的项。
3. **失败后可重入**：故意让构建失败一次（例如把 `CSC_NAME` 改错），确认 `release-free-<版本>/` 被自动删掉，
   紧接着重跑**不报**“输出目录不是空目录”。

### 2.4 官方 claude CLI 的来源校验（PR #197）

1. 用官方脚本装一份原生 `claude`（落在 `~/.local/bin/claude`），从星芒客户端里启动它。
   **算通过**：正常启动。
2. 把那个二进制重签成 ad-hoc 再启动：`codesign -f -s - ~/.local/bin/claude`。
   **算通过**：被拒绝，并给出“未通过 Anthropic Developer ID 签名校验”这类提示。

**不通过**：第 1 条起不来是误伤付费客户，必须告诉我（团队号写死的是 `Q6L2SF6YDW`）。

### 2.5 视觉验收（PR #161，CI 不跑）

```bash
npm run test:mac:visual
```

**算通过**：四个场景跑完；首页出现 **5 个**工具行（Linux 上只有 4 个，因为 Codex 桌面端只在 macOS 上可启动）；
人眼看 `artifacts/macos-qa/` 下的截图和 `visual-qa-result.json` 里的几何数值没问题。

### 2.6 更新链路（上传之后才能验）

免费包**会**启用更新功能。更新服务器上只要缺 `latest-mac.yml`，客户端给出的就是“更新失败”，
而不是“本地开发包不检查更新”——所以清单没传齐之前不要让客户去点检查更新。

上传顺序：先两份 ZIP、两份 DMG、两份 ZIP blockmap，**最后**原子替换 `latest-mac.yml`（它只引用两份 ZIP）。
传完执行：

```bash
npm run update:verify-feed -- --platform=macos
```

**算通过**：双架构元数据、被引用文件的大小与 SHA-512、两份 blockmap 全部通过，然后再在旧版本上验一次
“检查更新 → 下载 → 重启安装 → 版本号变了且配置还在”。

---

## 3. 加速线路：默认不带，要带得显式开

`npm run dist:mac:free` 默认出的包**不含**加速线路，包里不会有 `resources/acceleration`，这是正常的，不要当缺陷报上来。

要出带线路的包，先按 `RELEASING.md` 第 2 节分别准备 arm64 与 x64 两个资源目录（都放在项目目录之外），再多传两个参数：

```bash
CSC_NAME='<身份名>' XINGMANG_MAC_SIGNING_SHA256='<64 位 SHA-256 指纹>' \
  npm run dist:mac:free -- \
  --acceleration-arm64 "$HOME/私有发布/<版本号>/acceleration-arm64" \
  --acceleration-x64 "$HOME/私有发布/<版本号>/acceleration-x64"
```

设置 `XINGMANG_ACCELERATION_BUNDLE_DIR` 环境变量**没有用**，它会被构建入口清掉——这是故意的，防的是上一次构建的残留变量让一个公开包悄悄带上私有节点。只有上面这两个参数算数。

开了开关之后，构建会分两次跑 electron-builder（先 arm64 后 x64，各自只看到自己架构的资源），再把两次的产物合并进同一个 `release-free-<版本号>` 目录。**验收点不变**：最后仍然是那 8 个文件，多一个少一个都会被产物校验拒掉；中途的 `arch-arm64` / `arch-x64` 两个子目录会在合并后自动删掉，如果构建结束后它们还在，说明合并没跑完，把日志发我。

带线路的包额外要看三条（不带线路时跳过）：

1. 解包 DMG 后，`星芒AI管理工具.app/Contents/Resources/acceleration/` 里应有 `mihomo`、`profile.yaml`、`manifest.json`、`LICENSE-mihomo.txt`、`THIRD-PARTY-NOTICES.txt` 五个文件，不多不少。
2. `manifest.json` 里的 `arch` 要和这个包的架构一致（arm64 包里写 `arm64`，x64 包里写 `x64`）。两个包拿错资源正是分架构构建最容易出的错。
3. 在应用里打开加速，确认线路列表能出来、能连上；停止后再启动一次。

CI 不跑这条路径：GitHub runner 上没有私有资源，`--ci-temporary-signing` 与这两个参数是互斥的，所以 CI 只验不带线路的构建。带线路的包只能在发布 Mac 上验。

---

## 4. 发现问题时给我什么

1. **包的版本号与 commit**（`git rev-parse HEAD`）
2. **完整错误文案**（截图或原文，不要概括）
3. **复现步骤**
4. **运行日志**：软件里“运行日志”页 → 导出（已自动脱敏，不含 Key）
5. 签名类问题另附 `codesign -dvvv --entitlements - '<路径>/星芒AI管理工具.app'` 的输出

---

## 5. 可选回归（2026-08-09 第三轮遗留，仍然有效）

不挡发版，方便时做：

1. **agent 链自愈**：`rm ~/.grok/bin/agent`（保留 grok）→ 在应用里只做一次扫描或“检查更新”、**不点安装** →
   `ls -la ~/.grok/bin/` 确认 agent 链已被静默重建且与 grok 同目标。
2. **历史隔离文件纳管**：连续两轮“装 → 卸”且**不执行**清理命令 → 第三轮卸载时对话框应列出**全部**历史
   `.removing` 文件且清理命令包含它们 → 执行后 `~/.grok/bin` 无残留隐藏文件、`downloads/` 分毫未动。
3. **字节数与实际一致**：同版本重装（grok + agent 指同一目标）→ 卸载对话框“程序文件共约 X MiB”应为**单份**大小。
