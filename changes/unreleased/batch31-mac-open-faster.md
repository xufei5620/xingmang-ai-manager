## 用户

- 点「打开」WorkBuddy、Claude Desktop、OpenCode 以后，这几行不再一起变灰重新检测；Mac 上打开前只核对要打开的那一个，开得更快。

## 开发

- 第三十一批 C 的 1～3（第 4 点「打开也认几分钟内验过的」要放宽「执行之前现验」，没做）。
- `external-client-runtime.ts`：Mac 上 `launch` 只现验要打开的那一个（`inspectMac` 的 `only`），spctl 和 WorkBuddy 的 `codesign --deep` 一项不少；
  Windows 的清点是一整段脚本，没动。
- Mac 上展示用的检测（`scan`，`reuseSignatures`）照 Windows `knownSignatures` 的规矩，按包指纹（包目录 dev/ino/mtime、Info.plist mtime/size、主程序 dev/ino/mtime/size，同 `macos-codex-app.ts`）
  认 5 分钟内验过的，只记通过的，现验没过就忘掉；`launch`、`install` 从不认。打开时现验通过的也记下，打开后那次后台重扫不再深验一遍。
- `App.tsx` 的 `launchExternal` 打开成功后不再整轮 `refreshExternal()`：`useToolbox` 的 `noteExternalLaunched` 先把那一行写成「运行中」（`withExternalRunning`），
  再 `refreshExternal(false, { quiet: true })` 悄悄核一次：不置 `externalLoading`，没读到就留着上次的结果、不出红条。主进程打开后作废缓存那一行不动。
- 测试：`external-client-runtime.test.ts` 补七条 Mac 签名核对，`useToolbox.test.ts` 补两条，`app-check.mjs` 补两条（开完三行能点、后台没读到不出红条）。
