## 用户

- 教程「备份、更新与数据」里讲更新的那一步改成现在的走法：工具箱新版本在后台下好，关掉软件或下次打开时自动装上，装前先弹通知，Windows 授权窗口点「是」；不想自动装去「设置」→「启动与关闭」关掉「自动更新」；自动装没装上怎么办；AI 工具更新后不对劲可以在「…」里「退回更新前的版本」。
- 游戏加速页去掉了那颗一直写着「暂未开放」、按不动的模式开关和顶上的「标准模式」字样；加速照旧只改这台电脑的系统代理，不接管整台电脑的网络。教程「游戏加速」一章、配图和「使用帮助」也跟着改了说法。

## 开发

- 第二十一批 6（yoyo 2026-09-30 回「其他的全部按你的推荐」，含去掉 TUN 开关）。`registry/tutorials.ts` 改更新一步、加速两句与关键词；`TutorialIllustration.tsx` 改加速插图说明和那一行；`AccelerationView.tsx` 删模式开关行与 stage 顶部模式标签，`mode` / `onModeChange` 两个 prop 随之去掉（`AccelerationPage.tsx` 不再传），对应 CSS 删掉；`App.tsx` 加速使用帮助去掉「TUN 模式暂未开放」。
- 控制器 `controller.ts`、主进程加速服务与偏好存储的 mode 字段都没动：开关一直被 `supportedModes` 挡着，没人存得下 TUN 偏好，开始加速照旧用 `system-proxy`。
- 测试：`tutorials.test.ts` 把更新一步的按钮名钉在 `settingsGroups`、`updateFailureLabels`、`updateLabels` 上，并断言教程全文不出现 TUN；`AccelerationView.test.tsx` 断言连接前后都没有模式开关和相关字样；`browser-check.mjs` 里计时那条用例去掉点 TUN 开关的步骤，改为断言开关不存在。商店那句由 #674 改。
