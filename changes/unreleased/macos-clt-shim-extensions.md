## 用户

- macOS：没装「命令行开发者工具」的 Mac 上，外接工具页不再把系统自带的 python3 算作「已装 Python」，添加要用 Python 的连接时会照常提示先装 Python。第一次装 Claude Code 插件时，如果系统自带的 git 用不了，会直接说明要先装命令行开发者工具，不再弹出苹果的系统对话框后再失败。打开外接工具页自动检查扩展更新时也不会再招出这个弹窗。

## 开发

- `electron/provider-extensions.ts` 接上 #346 的 `macos-command-line-tools.ts` 守卫：`inspectExtensionRuntimes` 的 Python 判断、`ensureClaudeOfficialMarketplace` 的 Git 判断（空壳时用 `claudeMarketplaceGitMissingMessage(platform, { commandLineToolsShim: true })` 的专门文案）、`createProviderSourceUpdateInspector` 的 Git 更新检查。服务与更新检查器新增可选注入 `platform` / `isCommandLineToolsShimBacked`，与 `runCommand` 分开，免得测试里假的 git 输出被当成 xcode-select 的回答。
