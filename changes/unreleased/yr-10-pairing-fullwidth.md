## 开发

- YR-10：`codex-remote-text.ts` 的 `normalizePairingAttempt` 比对前先把全角数字（０-９）换成半角。JS 的 `\d`
  只认半角，手机输入法切在全角时发来的「１２３４５６」以前认不出来，`tryPair` 直接 return：不回话、不算错一次、
  卡片上也不提示。只换全角数字，圈码、上标这类别的写法照旧不认；电脑时间快了时认配对码的 `warnClockAhead`
  走的是同一个函数，一起跟上。用户行并进 `codex-remote-fixes-0224.md`。
