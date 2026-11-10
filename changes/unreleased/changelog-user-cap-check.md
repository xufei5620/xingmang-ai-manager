## 开发

- 0.2.24 的「## 用户」合起来已经 71 条，超过更新页一版 60 条的上限（`scripts/bundle-release-notes.cjs` 的 `MAX_ITEMS`），
  发版时 `npm run compile` 和发布前置检查会直接报错停下（0.2.24 深查复查第 1 条）。这次把同类的并掉，回到 48 条，给还开着的 PR 留余量：
  视频剪辑 13 条并成 4 条（每个镜头能调的、拼成片多的选项、草稿箱和教程、生成视频的几处修复），画布 14 条并成 8 条，
  聊天记录 4 条并成 2 条，自动更新 3 条并成 1 条，作品库、检查页、装工具下载、弹窗各 2 条并成 1 条。被并掉的分片只留「## 开发」，
  客户报过的两条（`001-` 开头）照旧排最前，意思一条没删。
- `official-switch-withdraws-bypass.md` 的「用户」那句补上老客户不变（复查第 3 条）：0.2.24 之前就接过星芒的配置没有 `filled` 记号，
  切回官方时那两项照旧不撤，原来那句「之后官方 Claude Code 跑命令前会照常问你」对他们不成立。
- `changelog:check` 开始数条数：`countUserItems` 把 `release-notes.md`「未发布」段里已有的和各分片的「## 用户」放在一起，
  用 `bundle-release-notes.cjs` 的 `splitReleaseNoteItems` 数（续行不多算，和发版构建同一个数法），超过 `MAX_ITEMS` 就报错，
  让加上第 61 条的那个 PR 当场并掉几条；通过时也打出现在是多少条。`changelog-collect.test.cjs` 钉住（正好放满能过、多一条报错且不动文件、续行和开发条目不算）。
