## 用户

- Mac 上（Windows 上以管理员身份运行星芒时也一样）更新完 Claude Code、Codex、Gemini CLI，刚显示「完成」就退出星芒、关机，
  或者星芒意外关掉，过几天再装、更新或卸载别的工具时，刚更新好的那个不会再被悄悄换回旧版。
- 同样在 Mac 上（以及以管理员身份运行的 Windows），装或更新工具下到一半就退出留下的临时文件夹（一次几十到几百 MB），
  星芒过 6 小时会自己清掉，不再一直占着硬盘。

## 开发

- 第三十七批 B：托管目录（Mac、Linux，Windows 按管理员身份运行时）的装和更新在 `npm-cache/npm-transaction-XXXXXX` 里做，
  正在用的工具目录先挪成里面的 `previous-prefix`，新版换上、检查通过、报完成，最后 `finally` 才删整个事务目录。删完之前退出、
  关机、崩掉，或者删到一半失败，下次装、更新、卸载任何一个工具开头的恢复（`managed-cli.ts`）只看到 `previous-prefix`，分不清
  新版检查过没有，一律退回旧版，删了一半时退回来的还是残缺的。
- `replaceManagedNpmPrefixAtomically` 检查通过后把 `previous-prefix` 改名成 `superseded-prefix`（用传进来的
  `operations.rename`，EPERM / EACCES / EBUSY / EAGAIN 照 `safe-local-data.ts` 的规矩等 20/40/80/160 毫秒，最多 5 次），
  返回 `{ backupRetired }`；改不成就留原名、和以前一样，只记一条 `cli.install.backup-retire-failed`。恢复的判断不动
  （本来就只认 `previous-prefix`），加了注释，最后删事务目录那一下也加了重试。检查没过、检查前就断了的退回保护不变。
- `install-leftovers.ts` 多扫托管 npm 缓存目录（`managedNpmCacheRoot`；普通权限的 Windows 不扫）里的 `npm-transaction-`
  加 6 位随机串，照旧 6 小时以上才删、不跟链接；新加的 `preserveIfContains` 让还有 `previous-prefix` 的事务再旧也不删，
  留给恢复（恢复做完剩下的 `interrupted-prefix` 照删）。Windows 按管理员身份运行时，要这次运行已经加固并核过那个目录的
  ACL（`isRegisteredTrustedManagedWindowsPath`）才交给清理。`finally` 的删除加 `maxRetries: 2, retryDelay: 200`，删不掉记
  `cli.install.transaction-cleanup-failed`（路径去掉用户目录）。
- 测试：Linux 上真走一遍更新、让收尾删除失败、再准备托管目录，改前 Codex 被退回 0.1.0，改后保持新版，6 小时后残留被清掉；
  `managed-cli.test.ts` 新加的两条在三个平台上都跑。
