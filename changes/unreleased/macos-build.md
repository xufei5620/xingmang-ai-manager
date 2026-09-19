## 开发

- macOS 免费分发构建脚本 `scripts/run-macos-free-build.cjs` 收口六条发版链路问题（P-18、P-19、
  P-24、P-25、P-34、P-39），并清掉 P-37 里那处永假的返回码判断。
- P-18：临时 keychain 口令与 P12 口令不再出现在 `security` 的命令行参数里，改为把整条子命令
  写进 `security -i` 的 stdin；同机 `ps -axww` 因此再也读不到它们。失败信息里的口令会被替换成
  `***`。同时拒绝在 `RUNNER_ENVIRONMENT` 不是 `github-hosted` 的 runner 上跑临时签名。
- P-19：注册 SIGINT / SIGTERM 处理，取消构建时先跑完同一套清理再把信号重新抛给自己，不再把
  用户域 keychain 搜索列表留在指向已消失的临时 keychain 的状态；解析结果为空或含相对路径时
  直接拒绝改动，恢复动作也不会再退化成会清空搜索列表的裸 `list-keychains -d user -s`。
- P-24：`BUILD_MODE_ENVIRONMENT_NAMES` 补上 `XINGMANG_UNSIGNED_RELEASE`、
  `XINGMANG_ACCELERATION_BUNDLE_DIR`、`XINGMANG_SIGNING_PUBLISHER`，免费分发包不会再因为环境
  残留而带上私有加速资源。
- P-25：本地 `dist:mac:free` 失败后自己删掉本次创建的输出目录（按创建时记录的 dev/ino 复核后
  再删），不必在发布压力下手工 `rm -rf`；调用方自带的空目录一律不删，只在报错里给出绝对路径。
  `scripts/update-release-utils.cjs` 的「输出目录不是空目录」文案同步说明该怎么处理。
- P-34：keychain 口令、P12 口令与临时输出目录名各取一份独立随机熵，任一泄露不再能推出另一个。
- P-39：`resolveMacosSecurityCommand` 的第二个参数不再被静默丢弃，它现在就是声明哪些参数是机密
  的通道。
