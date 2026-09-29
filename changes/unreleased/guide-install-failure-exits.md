## 用户

- 新手引导里装工具没装上时，不再只有「再试一次」：Node.js 太旧认不了公司电脑的证书时，直接给「换成新版 Node.js」，换好后引导接着把工具装完；其它原因（磁盘满、被杀毒拦、下载超时等）也和别处一样给「查看日志」「找客服」这些出口。

## 开发

- `StartGuide` 的安装类失败（安装、更新、准备环境、准备 Python）复用错误框的出口表（新增 `guideInstallExits`），`replaceNode` 按 `canReplaceNode` 过滤、换不了时补「找客服」；`onFailureAction` 多一个可选的 `retry`，App 的 `runGuideFailureAction` 新增 `replaceNode` 分支，换完重跑引导里失败的那一步。
