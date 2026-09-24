## 开发

- 浏览器分片的夹具在一次导航秒败（如 Windows 跑机上 `net::ERR_NO_BUFFER_SPACE`）后，先等完这次导航分到的那段时间再重新导航，不再在几百毫秒内把三次导航全用光；总预算仍是 90 秒，没有调大任何超时。
- `electron/claude-desktop-manifest.test.ts` 里只在 Windows 上跑的清单读取用例原来现场写清单、再真起 powershell.exe 读六遍，冷启动在跑机上连 90 秒都等不到（run 36042396731），CI 只看得到「清单无法安全读取」。
  生成脚本拆成 `buildClaudeDesktopManifestInspectionScript`（行为不变），改成所有平台都跑的文本检查：联接检查在打开文件前、大小检查与禁 DTD / 外部解析 / 字符上限在建 XmlReader 前；
  带恶意字符的路径只以 base64 出现在闭合的单引号字面量里；XPath 用到的命名空间与商店清单声明的一致；实际交给 PowerShell 的正是这份脚本。
- `e2e/fixture-readiness.mjs` 新增 `replayCollectedPromise`：Playwright「Resulting promise was garbage collected」的重放统一走共享的次数与退避（4 次，500/1000/2000ms）。
  electron-ci-smoke、onboarding-smoke、renderer-v2-native、renderer-v2-native-close-race 原来各自平着等 500ms 重试 3 次，run 36042396731 的 renderer-v2-native 首次读取就在 1.5 秒内三次全丢；
  门禁用例改为扫描 e2e 下所有冒烟，重放必须走共享模块，不许自带间隔。
