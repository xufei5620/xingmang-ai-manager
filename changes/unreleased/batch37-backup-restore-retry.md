## 用户

- Windows 上安全软件或系统索引正好在扫文件的那一下，点「改用当前账号」「备份并重置」、在「备份」页备份或恢复、
  给 Claude Desktop 保存配置、在「技能」页开关或删掉 Codex 的技能，不会再偶尔失败、非得再点一次才好：星芒会自己
  等一小会儿再试。真写不进去时，提示和以前一样。

## 开发

- 第三十七批 C（第三十五批 B、#847 的后续）：#847 抽出的 `renameWithTransientRetrySync` 用到同类的几处换文件上，规矩不变
  （EPERM / EACCES / EBUSY / EAGAIN，等 20/40/80/160 毫秒，最多 5 次；用尽就原样抛出最后那个错误，后面的说法不变）。
  `backups.ts`：做备份最后把临时文件夹改名成正式备份（「改用当前账号」「备份并重置」、修提醒设置、开机补设置、备份页
  「创建备份」、恢复前那份都先走这一步，刚写进文件的文件夹被安全软件扫着时改不了名），恢复时挪开当前配置、换上备份、
  失败时往回换（单个文件里一处、整次回滚一处）；`claude-desktop-local-transaction.ts`：换文件和往回换；
  `codex-extensions.ts`：改写 config.toml（`setSkillEnabled`、`setPluginEnabled` 都走这里；新界面「技能」页开关 Codex
  技能用的是前者，「插件」页开关 Codex 插件走 CLI，不经过这里）和删 Skill 时把文件夹挪进回收站。
- 每次尝试前都重做原来的检查（原有检查的先后不变）：备份目录（`ensureSafeDataDirectory`，开头查过的那项，改名前
  再查）；恢复时的路径（`assertSafeTargetPath`）、回滚位置还空着、当前配置和快照一致、临时文件的快照和 SHA-256；
  Claude Desktop 的账号（`assertContext`）、各文件快照、暂存文件归属、目标文件；Codex config.toml 的路径和「单链接
  普通文件」检查（抽成 `assertReplaceableTomlFile`，备份前、每次换文件前各查一遍）；删 Skill 时两边的路径。等的时候
  被换成联接、多了硬链接的，照旧拒绝；恢复备份和 Claude Desktop 这两处还比对快照，被别的程序存了改动的也照旧拒绝、
  不盖掉。
- 整次回滚把挪开的那份放回去之前，多确认一次原位置空着（恢复上去的那份刚删掉）：等着重试的那一下若有程序在这儿新写了
  文件，不拿挪开的那份盖它，照旧按「回滚失败」把挪开的那份留着。
- `safe-local-data.ts` 没改。测试照 #847 的写法用 `vi.spyOn(fs, 'renameSync')` 模拟被占住：占一两下能等过去；一直占着照旧报
  原来的错、往回换照旧；等的时候被改了照旧拦下。
