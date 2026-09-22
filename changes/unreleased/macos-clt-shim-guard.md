## 用户

- macOS：没装「命令行开发者工具」的 Mac 上，打开软件、点「重新检测」或跑检查页时不会再弹出苹果那个「需要安装命令行开发者工具」的系统对话框了。这时 Git 和 Python 会显示为未安装，检查页会说明 macOS 自带的那份只是空壳，以及怎么装上。

## 开发

- 新增 `electron/macos-command-line-tools.ts`：macOS 上 PATH 命中 `/usr/bin/git` 或 `/usr/bin/python3` 时，先以 argv 调 `/usr/bin/xcode-select -p`，并确认「开发者目录/usr/bin/同名命令」确实是文件，才去跑 `--version`；否则按未安装返回，不执行空壳。`system-service.ts` 的 `inspectTool` 与 `diagnostics.ts` 的 `defaultInspectTool` 都接上了这道判断，检查页 Git / Python 两行在这种情况下给出空壳说明（第八批候选 1）。Windows 与其他路径（Homebrew、python.org）不受影响。
