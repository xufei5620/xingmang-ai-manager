## 用户

- 教程里的「打开个人中心办理充值」「查看用量与调用明细」「查看账号与密钥」现在会直接打开对应的那一页，
  不再都停在「我的账号」；「查看隐私与数据设置」会直接打开设置里的「隐私与数据」。
- 从检查页跳到设置时，就算之前打开过设置，也会落在要去的那一组，不再停在上次看的那组。

## 开发

- 全面检测 Q48：`registry/tutorials.ts` 的 `TutorialStep` 改为按页收窄的 `section`（个人中心分页 /
  设置分组，其他页写了就编译不过），教程按钮调 `navigate(step.page, step.section)`；个人中心复用
  Q29（#412）的带序号 `accountTab`。设置页只在挂载时 `takeSettingsGroup()`，外壳跳设置前用新增的
  `hasPendingSettingsGroup()` 看有无待取分组，有就换 key 重挂设置页，顺带修好检查页「网络」项在设置页已挂载时不生效。
- 新增 `registry/tutorials.test.ts`（「在哪里」点名了非默认分页的步骤必须声明同一分页）与
  `testing/app-check.mjs` 浏览器用例。
