## 开发

- #1090 评论补充（锁发布页）：`publish-release.yml` 收尾时 Release 已经在了，先查它的 `immutable`；接口明说锁了就不再
  `gh release upload`，给一条 `::warning::`，在运行摘要里列出这次没挂上发布页、只进了更新源的文件，写明要上发布页只能
  提升版本号。原来锁住以后补发另一个平台，会在更新源都换好之后报红。只有接口回 `true` 才算锁了，草稿（查这个地址是
  404）、查不了、不带这个字段都照原来那样传。新建 Release 那条路不改：`gh release create` 带着安装包时先建草稿、
  传完才发布，草稿不锁。`docs/RELEASING.md` 第 5 节补了一句。
