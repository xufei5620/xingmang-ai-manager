## 用户

- 教程「Mac 上准备 Node.js 和 Python」里要自己打开「终端」的那一步，写明了怎么找到它（按 Command + 空格，输入「终端」后回车），也把「命令行安装工具」换成了更好懂的说法。

## 开发

- 接 #728：`src/renderer-v2/registry/tutorials.ts` Mac 运行环境章 Homebrew 一步补上打开终端的方法，「不知道 Homebrew 是什么」改大白话。防残留测试扩到教程示意图：新增 `features/tutorial/TutorialIllustration.test.tsx`，逐张渲染全部示意图（含读屏文字），不许出现 npm、PATH、TOML、环境变量与泛指的 CLI，图片清单用 `Record<TutorialIllustrationId, true>` 钉住、新增示意图漏测是编译错；`tutorials.test.ts` 的可见文案检查加上 PATH、TOML。第二十四批候选 ⑨ 收尾，只改文案与测试。
