## 开发

- `macos-desktop-app-installer.ts`：Mac 装、更新 Codex 桌面端时，存储桶清单过期（`DesktopBucketIndexStaleError`）不再整路丢掉桶。
  顺序改成「新鲜的桶 → 官方 → 过期的桶 → 报官方那一路的错」，照 #1571 在 Windows 上的做法：`unpackFromBucket` 只因过期没用上时返回 `'stale'`，
  官方那一路没走通（取消、盘写满了除外）再带 `allowStale` 回头走一次，不进下载线路。更新时桶里那版不比装着的新就不下；
  回头那一次后面没有别的路了，`probeAlternative` 一律给 null，下得慢也接着下，断得接不上才停。进度那句和官方那一路同一句话，界面上的字没改。
  首页「可更新到 v…」（`macos-desktop-app-update.ts`）读过期清单照旧当不知道，这次没动。起因：0.2.24 深查「装工具和更新」S-1。
