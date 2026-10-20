## 开发

- 随包更新说明不再悄悄截到 60 条（#1334）：`scripts/bundle-release-notes.cjs` 在顶节就是这一版、条数超过 `MAX_ITEMS`（60）时抛
  `RELEASE_NOTES_TOO_MANY`，`npm run compile` 最后一步失败；`release:preflight`（`verify-release-environment.cjs` 新增的
  `assertReleaseNotesFitUpdatePage`）调同一个函数，在出包前先拦。顶节是「未发布」或上一版的构建照旧写 `notes: null`，日常测试包不受影响。
  主进程 `installed-release.ts` 的 60 条只防坏文件，测试钉住两边是同一个数；单条超 1000 字照旧截断带「…」。
- 0.2.20 的 `## 用户` 从 84 条合到 45 条：相近的几条并进同一个分片的那一条（被并走的分片只剩 `## 开发`），内容一句没删。客户报过的四件
  （用量账单反复要重新登录、Codex 桌面端「提交消息时出错」、Mac 反复弹密码、较慢 Mac 上 Codex 桌面端「检测失败」）的分片改名
  `001-`~`004-` 排在最前，冒号前那半句改成修好了什么：装完后角落卡片列的就是前 3 条的这半句。`docs/RELEASING.md` 与分片 README
  写明 60 条上限和 `001-` 这种排法。
