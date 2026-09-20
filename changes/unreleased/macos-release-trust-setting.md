## 开发

- 正式发布工作流的 macOS 作业不再卡在导入签名证书那一步。写用户域的信任设置要过
  `com.apple.trust-settings.user` 授权，runner 上没有图形会话可以确认，`security
  add-trusted-cert` 会一直挂到 30 秒超时；改走 `sudo` + 管理员域，以 root 执行即通过。
  信任设置仍然只针对 `codeSign` 策略，构建结束后原样撤销。
- 信任设置的 `-r` 参数按证书的 `basicConstraints` 决定：CA 证书用 `trustRoot`，
  其余用 `trustAsRoot`。写死其中一个，在证书轮换到 P-22 的新 profile 之后会被
  `security` 直接拒绝。
- 导入失败时把动过的东西全部放回去（撤信任、还原 keychain 搜索列表、删 keychain、
  删状态文件），而不是只删 keychain。搜索列表停在一个已删除的 keychain 上，会让这台
  机器后面每一次 `codesign` 与 `find-identity` 都解析到不存在的东西。
- 收尾步骤把「keychain 已经不在了」当作完成而不是失败。它在工作流里是 `if: always()`，
  之前会在导入失败之后再红一条，把真正的失败原因盖住。
