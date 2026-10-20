## 用户

- 装工具出错时的提示换成看得懂的中文和下一步：装工具、装 Node.js、卸载工具没成时只说是哪一种原因（磁盘满了、没有权限、连不上下载源、下载源那边出错、找不到要装的版本……），英文原话记进运行日志给客服看；装工具前到 npm 官方源核对安装清单连不上时，会说这一步只能走官方源，并提示开启网络加速或换个网络；工具的配置文件是个链接（比如用 dotfiles 工具管理）时，会说清是哪个文件、为什么不写、换成什么。
- 对话、画图、视频和充值出错时也各说一句该怎么办：对话太长、内容没过审核、所选分组下这个模型暂时用不了时各说一句，生图时参考图太大或没过审核也一样；画布上生成、保存、读取分组出错时，节点和提示条只写出错的原因，不再带一串「Error invoking remote method …」英文前缀；视频已经提交、一时查不到进度时，提示「请勿重复提交」，下次启动会接着查；充值、开通订阅时支付信息不对，统一提示「支付通道暂时异常，没有扣款，请联系客服」。报错里不再提已经不存在的页面和按钮，本机路径打码后显示为「本机路径」。

## 开发

- 报错改字 A 组（Refs #1076 #1100 #1101 #1093 #1057 #1111）：`ai-video-service.ts` 查进度断档换句；`payment-window.ts` 加 `PaymentCheckoutRejected`；`ai-chat-service.ts` / `ai-image-service.ts` 按上游原话分类；`claude-desktop-config.ts` 切换被拒那句换说法、原因挂 cause。
- 新增 `electron/npm-failure-reasons.ts`（零依赖，进 renderer 值导入名单）与 `failure-wording.ts` 的拼句函数：npm 装、卸、回滚按原因表说中文，错误码留在句尾「（错误码 X）」给 `operation-error.ts` 认；找不到版本、被拒、没过校验、组件对不上几类整句自带下一步，错误框不配标题。`withToolCertificateHint` 改拿原话认证书。
- 新增 `electron/config-link-refusal.ts`：配置文件本身是符号链接或硬链接时先认出来、换说法，校验一个不放宽；错误目录加 `configLink`、`configDiskFull`、`downloadUnreachable`、`downloadSourceError`、`officialRegistryUnreachable` 五类，握手被掐断（#1060）在安装场景改归 `downloadUnreachable`。
- `node-runtime.ts` 的 Node.js 自动安装失败只取一个原因上屏（`describeNodeInstallFailure`），winget 与各源原话挂 cause。
- 上屏句换成中文时，原来的错误一律挂在 `cause` 上，运行日志照记。
