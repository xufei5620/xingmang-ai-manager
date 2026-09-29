## 用户

- 公司电脑上装工具提示「Node.js 太旧，认不了这台电脑的证书」时，提示框里多了一颗「换成新版 Node.js」：点了先说清会发生什么，确认后星芒装上新版并接着重试刚才没装成的工具。以前提示叫你去「安装卸载」页点「安装」，那边只回「无需重复安装」，怎么点都换不了（Windows）。
- 「安装卸载」页里，认不了公司证书的旧版 Node.js 那一行按钮改叫「换成新版」，同样先确认再换（Windows）。

## 开发

- 第十八批 4：`runtime:install-node` 加可选参数 `{ reason: 'certificate' }`（ipc-contract / preload / ipc 三处同改，`parseNodeRuntimeInstallRequest` 白名单校验）。Windows 上带它且当前 Node.js 低于 22.19 / 24.6 时不再走「无需重复安装」，照常装最新 LTS；装完仍读到旧版（被另一份排在前面）直接报错说明，不假装换好。Mac 不换（代下的那份排在 PATH 最后），错误框出口改为「找客服」。
- 渲染层：错误目录 `toolCertOutdatedNode` 加「换成新版 Node.js」动作（`replaceNode`，有它时当主按钮）；新增 `features/tools/node-replace.ts` 与 `NodeReplaceDialog`，错误框与「安装卸载」页共用；`toolCertificateMessages.outdatedNode` 不再指向「安装卸载」页。
