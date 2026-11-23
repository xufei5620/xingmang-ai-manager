## 用户

- 首页新增 Antigravity 命令行和 Antigravity 桌面端，可一键安装，并自动使用当前账号。

## 开发

- Antigravity 接中转第八步：首页工具区加两张卡（`antigravityCli`、`antigravity`，排在 OpenAI 之后、xAI 之前，`registry/clients.ts` 的 `antigravityTools`）。只有「安装」「打开」两件事：安装进度走 `antigravity:install-progress`，装完那一句带上主进程没写成设置的原因；命令行在记住的项目文件夹里开，「…」里可选其他文件夹；桌面端开着拿不到新设置时（`closeFirst`）请客户先退出。检测结果放在 `useToolbox` 的 `antigravity`，首屏扫描后、点「重新检测」、装完和打开后各读一次，这台电脑用不了（Linux）时不摆这两张卡。图标照 @lobehub/icons 5.18.0 的 Antigravity 原色标抄进 `vendor-icons.tsx`。主进程 Antigravity 这几步的报错统一改成正式说法：网址、校验码、HTTP 状态这类细节只留在错误的 cause 里（运行日志照记），客户看到的是一句能照着做的话；超时单独说「请检查网络后重试」；带「环境变量」「中转」的四句换成不带技术词的说法。
