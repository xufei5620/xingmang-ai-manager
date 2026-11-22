## 用户

- 画布中的节点名称、分组名称及「风格」以网址或路径开头时，现可正常保存。

## 开发

- 客户那句 yoyo 2026-11-23 回「名字说明加」定的字。
- 画布内核同步到 xingmang-canvas kernel-v0.1.17（4261424，`scripts/sync-canvas-kernel.mjs` 按 tag 原样同步，没有本地补丁），只带进 xc #61（#1368 第 4 条小尾巴，yoyo 2026-11-22 亲手打字同意「我同意画布节点名、分组名、风格开头是网址或路径时也照原样保存」）：
  - 节点名（任何已知节点的根 `settings.title`，分组名也是它）和漫剧圣经的「风格」（`drama-bible` 根 `settings.stylePrompt`）以前保存、重开时被内核两道检查悄悄丢掉：开头像网址、路径或「英文加冒号」（如 `Step1:`），或中间带 `https://`、`D:\`、`/Users/` 的都存不住，重开变回默认名。现在 `workflow-schema.ts` 和 `workflow-sanitizer.ts` 都经 `isLabelSetting` 只对这三项免掉「像不像位置」这一条。
- 主进程 `electron/canvas-project-package.ts` 同一道检查一起放宽，否则内核不再丢这些名字后，自动保存会整份报「画布项目节点设置不安全」：`validateNodeSettings` 改成逐个根键过 `validateRootSetting`，便签正文照旧，根 `title`（任何节点）和 `drama-bible` 的根 `stylePrompt` 只留 1 万字上限，其余键、嵌套设置、别的节点上的 `stylePrompt` 照旧查位置，敏感键名照旧拒。
- `electron/canvas-project-package.test.ts` 补三项各种开头都能存、上限和其余键照旧（旧代码上红），末尾加 `… with random inputs` 一节：任意节点类型的名字都收，除这三项和便签正文外任何根键上像位置的字都拒，嵌套在这几个键下面的照旧拒。
