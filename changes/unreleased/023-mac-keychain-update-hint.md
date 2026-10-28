## 用户

- Mac 上装新版之前，星芒现在每一处都会先说一句：重启后可能弹出钥匙串密码框，输入这台 Mac 的开机密码，点「始终允许」就好。
  以前只有设置页的「重启并安装」说了，跳出来问「现在装上吗」、必须更新、自动装的通知和退出时那一问都没提。

## 开发

- 新增 `electron/mac-keychain-update-copy.ts`（零依赖，进 `valueImportable`）放 `macKeychainUpdateHint`，原来那句从
  `VersionCard.tsx` 挪过来，字不变；只在 Mac 上补到跳框（`buildInstallPrompt`）、必须更新那层（`RequiredUpdateGate` 新增可选
  `mac`，缺省不显示）、打开时/退出时自动装的通知和窗口预告卡（`buildAutoInstallNotice`）、退出时那一问（`quitInstallPrompt`
  新增可选 `platform`，缺省 = 旧行为）。Windows、Linux 的字不变，测试钉住。yoyo 10-28 回「钥匙串提示改」。
- 起因：自签证书没有苹果团队号，登录钥匙串按每一版的程序指纹（`cdhash`）放行「xingmang-ai-manager Safe Storage」，每升一版
  第一次打开都会在窗口出来之前弹密码框（10-28 升级冒烟在 runner 上对照过）。签名身份本来就没变，解决不了；不换成苹果开发者
  证书，代码里只能事先说清楚。
