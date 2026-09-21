## 开发

- `electron/system-service.test.ts` 里两条关于「已验证版本名单」的断言不再写死 `2.1.277`，改成从
  `cliVerifiedVersions.claude.recommended` 读，配套加了 `recommendedClaudeVersion()` 与
  `versionAboveRecommended()` 两个取值器。原先抬一次推荐版本就要跟着改一次测试，而「改测试迁就
  代码」恰恰是这份名单最不该养成的习惯。已装的 `2.1.276` 仍写死：它落在名单里那条
  2.1.275–2.1.277 的不兼容区间里，是历史事实，不会随巡检移动。行为无变化。
