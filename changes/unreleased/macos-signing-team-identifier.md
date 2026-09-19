## 用户

- 修复 macOS 版装上之后一启动就弹「应用因为出现问题而无法打开」：系统的一项校验会核对应用和它随带的
  运行时是否出自同一个发布者，而这个凭据只有苹果签发的证书才带得上，我们的自签名版本永远没有，于是
  应用在自己的代码跑起来之前就被停掉了。现在这项校验对自签名版本关闭，其余加固照旧；等拿到苹果开发者
  证书会重新开启。

## 开发

- `build/entitlements.mac.adhoc.plist` 与它的 inherit 版现在用于**全部** macOS 构建（原先只用于 ad-hoc
  `--dir` 构建），即在 `allow-jit` 之外授予 `com.apple.security.cs.disable-library-validation`。
  hardened runtime 的 library validation 要求进程与它加载的每个库带同一个 team identifier，而该字段
  只有苹果签发的证书才有：没有它，这道校验分辨不出随包框架和任何别的框架，唯一效果是让包起不来
  （dyld：`mapping process and mapped file (non-platform) have different Team IDs`）。签名封印与 hardened
  runtime 的其余部分不变。`build/entitlements.mac.plist` 保留给 Developer ID，撤回步骤写在
  `docs/RELEASING.md` 第 2.1 节。
- 撤回本次发布周期内先前那次无效修法：`scripts/create-macos-free-signing-certificate.cjs` 的证书主题
  改回 `/CN=<名称>`，`scripts/verify-macos-free-signing.cjs` 去掉要求 `OU` 的
  `assertSigningCertificateTeamIdentifier`。带 OU 的证书签出来的包实测仍是 `TeamIdentifier=not set`，
  codesign 不会把自签证书的任何主题字段当作 team identifier。**因此没有因为这条而必须重新生成证书。**
- `scripts/verify-macos-free-artifacts.cjs` 不再写死一张 entitlements 允许清单，改为先读签名自己的
  `TeamIdentifier`（`parseCodesignTeamIdentifier`，唯一一行、失败即拒）再推导：没有 team identifier 时
  必须带 `disable-library-validation`，有时必须不带，两个方向都判失败；并核对每个 helper 与主可执行文件
  的 team identifier 一致。
- 新增 `e2e/macos-launch-smoke.mjs`，解压对应架构的 ZIP 并在隔离 HOME 与独立 user-data 下真正启动打包后的
  `.app`，进程自行退出即失败并打印 dyld 输出。`quality.yml` 的 macOS 作业（改用 `--ci-keep-package`）与
  `package-for-testing.yml` 的 macOS 作业都会跑它——2026-09-19 那份包通过了全部产物校验，**读产物的检查
  永远看不见启动期的失败**。
