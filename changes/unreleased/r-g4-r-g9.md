## 用户

- 保存工具配置或登录后自动写入密钥时，如果本机没能记下这次选择的密钥来源，现在会给出提示，
  不再出现工具卡上来源显示错误却全程无提示的情况。
- 统一了账号密钥写入后的复核提示文案，同一个问题在不同页面不再出现几种说法。

## 开发

- R-G4：`renderer-v2/features/tools/ConfigDialog.tsx` 的 `markerWarning` 此前永远是空字符串，
  四处 `writeManualSourceMarker` 的返回值被丢弃。新增 `source-marker.ts` 的
  `applyManualSourceMarker`，写失败时返回给用户看的一句话，四处保存路径与
  `features/tools/account-bootstrap.ts` 的账号写入复核都接上它；前者走
  `App.tsx` 的 `finishConfigSave(warning)`，后者并进 bootstrap 的 `warnings`。
- R-G9：把 `account-bootstrap.ts` 的五条复核失败文案收口到 `configurationFailureMessages`，
  以「当前账号」为主语并去掉站点指向。legacy `src/account-provisioning.ts` 已冻结未动，
  两侧仍存在的差异记在 PR 说明里。
