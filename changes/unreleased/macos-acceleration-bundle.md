## 用户

- macOS 安装包现在可以携带加速线路。

## 开发

- `npm run dist:mac:free` 新增 `--acceleration-arm64` / `--acceleration-x64` 两个命令行开关：给出各架构的
  私有资源目录后，入口改为分两次单架构调用 electron-builder（各自只看到自己架构的资源目录），再把两次产物
  合并进同一个发布目录交给现有产物校验；不传参数时行为与此前完全一致，仍是一次 `--arm64 --x64` 构建。
- 开关只认命令行，不放松 P-24 的环境清洗：继承来的 `XINGMANG_ACCELERATION_BUNDLE_DIR` 仍会被删掉，只有
  显式给出、且 `manifest.json` 的 `platform` / `arch` 与目标架构相符的目录才会写回子进程环境，写反两个
  参数在构建开始前就被拒。两个架构必须同时提供，`--ci-temporary-signing` 与这两个开关互斥。
- 新增 `scripts/merge-macos-free-artifacts.cjs`：校验两个分架构输出目录（产物齐全、无越界产物、
  `latest-mac.yml` 确属该架构与该版本），把六个产物移入发布目录，合并出同时引用两份 ZIP 的
  `latest-mac.yml`（以 arm64 那份为底，只替换文件列表），再删掉分架构子目录；全部检查通过后才开始移动。
- `docs/RELEASING.md` 第 2 节、`docs/MACOS_FREE_DISTRIBUTION.md`、`docs/MACOS-VERIFY-RUNBOOK.md` 第 3 节与
  `docs/GLOBAL-ACCELERATION.md` 里「macOS 包带不了线路」的说法改为带开关的做法。
