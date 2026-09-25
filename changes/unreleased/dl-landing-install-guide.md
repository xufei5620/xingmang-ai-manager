## 开发

- 下载页补上「Windows 第一次安装」两步（蓝色「Windows 已保护你的电脑」→「更多信息」→「仍要运行」），Mac 两项下载写明需要 macOS 13 或更新，教程说清怎么看自己是哪种芯片，并把「Gatekeeper」「Apple 公证」「DMG」换成大白话。只改仓库里的下载页源文件，上线仍需手动发布下载页。新增 `scripts/dl-landing-install-guide.test.cjs` 把最低 macOS 版本和构建配置钉在一起。
