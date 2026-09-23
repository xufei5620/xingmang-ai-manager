## 用户

- 自己改过工具安装位置的电脑，安装和更新现在会装到你原来的位置，不会再另装一份到别处；装完你自己打开的就是新版本。

## 开发

- 全面检测 Q19。普通权限（Windows same-user 与 Linux）安装给 npm 传的是空 `--userconfig`，用户 `.npmrc` 里的 `prefix` 跟着被丢掉，新版装进 npm 内置默认目录（Windows 是 `%APPDATA%\npm`），用户自己敲的命令仍是旧版。
- 新增 `electron/npm-user-prefix.ts`：按 npm 的规则找用户配置（`npm_config_userconfig`，否则 `HOME`/`os.homedir()` 下的 `.npmrc`），经 `readBoundedUtf8File` 读取（64 KB 上限、拒绝链接），照 `ini` 的解析只取顶层 `prefix`，做 `${VAR}` 与 `~` 展开；只接受绝对路径（Windows 限盘符或 UNC，拒绝设备路径），且其命令目录必须在 PATH 上，否则保持旧行为。设了 `npm_config_prefix` 时 npm 本来就认它，不另外传。
- `system-service.ts` 在非托管、非提权的安装里把这个值作为 `--prefix` 传入 `buildCliMaintenancePlan`，占用检测也改看这个目录；空 `--userconfig` 保留，源、脚本策略等其余配置依旧不生效。提权（trusted-only）与 macOS 托管目录不读用户配置，行为不变。卸载本来就按检测到的安装目录传 `--prefix`，无需改动。
- npm 行为在 Linux 沙箱（npm 10.9）验证过：空 `--userconfig` 时装进默认前缀，加 `--prefix` 后装进指定目录；Windows 上的表现是按 npm 同一套配置加载顺序推断的，未在真机验证。
