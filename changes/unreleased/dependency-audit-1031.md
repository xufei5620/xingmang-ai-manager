## 开发

- 构建依赖：follow-redirects 升到 1.16.2（GHSA-mrwp-f3q8-3g9p）、joi 升到 18.3.1
  （GHSA-4528-x5fx-h6hg），都经 wait-on 进来，只动锁文件。
- `scripts/audit-development-dependencies.cjs` 给 minimatch 的 GHSA-g3hv-75wg-m249 开了一条窄例外，
  到北京时间 2026-11-30 当天结束（yoyo 10-31 打字同意）。只有 11 版修了且不回补旧版，
  electron-builder 最新版仍要 ^10，强换 11 会弄坏 asar 3.x、dir-compare 和 glob 7；
  我们的调用方都碰不到出事的那段代码。例外只认这一条公告、只认挂在 minimatch 上、
  最高中危，依赖链里任何别的公告、悬空节点或计数对不上都照样红；到期后自己变红，
  公告消失后会提示删掉这条例外。
