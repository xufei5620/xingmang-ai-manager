## 用户

- 首页工具行的推荐版本后面会写一句这版修了什么，比如「推荐 2.1.277：修好了一个会让每次提问都失败的问题」；鼠标放到「更新」上也能看到整句。
- 装着的版本有已知问题时，提示改成大白话，比如「这个版本每次提问都会失败，换到推荐版本就好」。

## 开发

- `cli-verified-versions.ts`：`VerifiedCliRelease` 加可选 `userNote`（给客户看的一句话），`CliVersionAdvice` 加可选 `recommendedNote`，只在推荐版本比已装的新且安装钉在推荐版本（`pinned`）时带；`blocked[].reason` 全部改成不含技术词的说法，新测试钉住 `userNote` / `reason` 不出现 npm、400、中转、网关等词。
- renderer-v2 `versionSubtitle` 把这句接在「推荐 x」后面，新 `updateButtonHint` 给「更新」按钮加悬停说明。
- `docs/CLI-VERIFIED-VERSIONS.md`「怎么更新名单」补一步：抬推荐版本时同时改写 `userNote`。
