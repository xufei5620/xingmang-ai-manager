## 用户

- 教程「进阶：安装与使用命令行工具」和「Mac 上准备 Node.js 和 Python」两章改成大白话：不再出现 CLI、npm 这类词，也去掉了「需要 Node.js 与 npm」这句过时说法。现在写明点「安装」时缺的 Node.js 会自动准备好、Windows 上只装 Grok 用不到它，打开工具时按钮会直接写上次的文件夹名。

## 开发

- `src/renderer-v2/registry/tutorials.ts` 进阶章与 Mac 运行环境章泛指的「CLI」改「命令行工具」（Codex CLI 等产品名保留），删去 npm 字样与过时句；顺手改正下载章里引用的旧章名「Mac 上装 Node.js 和 Python」。`TutorialIllustration.tsx` 安装示意图运行环境一行去掉 npm，两段说明与启动示意图里的「CLI」改成大白话。`tutorials.test.ts` 新增断言：教程可见文案（keywords 除外，搜索仍可用）不含 npm 与泛指的 CLI。第二十四批候选 ⑨，只改文案。
