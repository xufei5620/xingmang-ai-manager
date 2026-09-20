## 用户

- 修复部分电脑安装完成后桌面上没有快捷方式的问题：安装结束时会检查桌面和开始菜单，缺了就补一个，
  已经有的不会被重复创建，也不会删掉你自己挪过位置的那一个。

## 开发

- `electron-builder.config.cjs` 的 nsis 段新增 `include: 'installer.nsh'`，并新增 `build/installer.nsh`
  的 `customInstall`：electron-builder 自己的 `addDesktopLink` / `addStartMenuLink` 有两条会静默跳过的
  路径——更新器拉起的 `--updated` 安装会把 `keepShortcuts` 置为 true 而整段不执行，以及 perMachine 安装
  往公共桌面 `CreateShortCut` 失败时不检查返回值。兜底宏只在快捷方式缺失时创建，公共桌面写不进去就退回
  当前用户桌面，永不删除任何文件，`--updated` 的静默安装不进入这段逻辑。
- 新增 `scripts/windows-installer-shortcuts.test.cjs`（已接入 `npm run test:scripts`），钉住 nsis 配置里
  两个快捷方式开关与 `include` 名字、兜底脚本只增不删、以及切到 current 上下文后必须切回。
