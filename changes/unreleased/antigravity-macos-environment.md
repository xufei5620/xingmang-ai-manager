## 开发

- Antigravity 接中转第二步，仍只有主进程：`electron/antigravity-macos-environment.ts` 在 Mac 上把四个网关变量写进产品目录里
  只有本人能读的 `gateway.sh` / `gateway.fish`，登录 shell 的启动文件末尾追加一段读它的标记，密钥不进 `~/.zprofile`；
  同一段把 agy 的位置 `$HOME/.local/bin` 加在 PATH 最后（不跑 `agy install`，它会把目录插到最前面）；
  zsh、bash、fish 都在测试里真开登录 shell 核对。`macos-shell-profile.ts` 导出了挑启动文件要用的几个判断，行为不变；
  两边共用的结果类型和「整份才写」的检查挪进 `antigravity-gateway.ts`。
- `electron/antigravity-cli-release.ts`：读 agy 官方版本清单（平台、版本号、构建号、下载地址、SHA-512），地址必须与按版本拼出的谷歌存储地址一字不差，供下一步的安装用。
