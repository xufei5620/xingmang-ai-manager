## 用户

- 安装时点「浏览」换到别的盘或文件夹，会自动在后面接上 xingmang-ai-manager 文件夹（比如选 D 盘变成 D:\xingmang-ai-manager），不会再出现只剩「D:\」、「安装」按钮是灰的、点不下去的情况。

## 开发

- `build/installer.nsh` 在安装程序顶层补一句 `InstallDir "$PROGRAMFILES64\${APP_FILENAME}"`。electron-builder 模板不写 InstallDir，NSIS 的浏览后自动追加（`install_directory_auto_append`）因此是空的，选盘根只剩 `D:\`，而 NSIS 默认不许装在盘根，按钮被禁用。默认位置仍由 multiUser.nsh 的 .onInit 决定；0.2.9 同样如此（installer.nsh 与模板在两版之间都没碰过这一处）。`scripts/windows-installer-install-directory.test.cjs` 钉住这一行。
