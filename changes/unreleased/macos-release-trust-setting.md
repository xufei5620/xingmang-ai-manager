## 开发

- 修好正式发布 macOS 作业的签名身份导入，两个问题叠在一起。其一：
  `security add-trusted-cert` 不带 `-d` 走用户域，要过
  `com.apple.trust-settings.user` 授权，runner 上没有图形会话可以确认，命令一直挂着
  直到撞上脚本的 30 秒超时；改走 `sudo -n` + 管理员域，以 root 执行即通过。
- 其二：`-k` 的语义是「证书不在就装进这个 keychain」。原先指向 `System.keychain`，
  于是同一张证书在机器上有两份，`find-identity` 把同一个身份列两次，签名预检的
  「匹配项恰好一个」判成「不存在或存在选择歧义」。改成指向那个一次性 keychain，
  证书本来就在里面，不会多出一份。
- 撤销不再调用 `remove-trusted-cert`。在 runner 上实测它根本回不来（给 60 秒也挂着），
  而删掉一次性 keychain 之后信任设置就没有作用对象了，删 keychain 本身就是撤销。
- `-r` 的取值按证书的 `basicConstraints` 决定：CA 证书用 `trustRoot`，其余用
  `trustAsRoot`。
- 导入失败时把动过的东西全部放回去（还原 keychain 搜索列表、删 keychain、删状态
  文件），而不是只删 keychain。搜索列表停在一个已删除的 keychain 上，会让这台机器
  后面每一次 `codesign` 与 `find-identity` 都解析到不存在的东西。
- 收尾步骤把「keychain 已经不在了」当作完成而不是失败。它在工作流里是
  `if: always()`，之前会在导入失败之后再红一条，把真正的失败原因盖住。
- 新增 `npm run test:mac:release-keychain`，在 quality.yml 的 macOS 作业里跑。它用
  现场生成的一次性证书（profile 与已发布那张相同）走与发布作业完全相同的脚本，断言
  导入后身份恰好一个且真的能签、撤销正常退出、撤销后不留痕迹。
  `publish-release.yml` 的 macos-build 挂 `environment: release`，PR 上从来不跑，
  这条链路此前唯一的验证机会就是真的发一次版，而每次都要产品所有者点一次批准。
