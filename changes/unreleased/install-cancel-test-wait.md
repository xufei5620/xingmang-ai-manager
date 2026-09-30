## 开发

- `electron/system-service.install-cancel.test.ts`「取消后第二次安装能起来」不再用 `vi.waitFor` 默认 1 秒去轮询下载次数，改为等夹具里「第 N 次 `npm ci` 已经开始」的 promise；第二次安装要是没走到下载就结束，立刻带着原因失败。修的是 Windows runner 忙时这条用例偶发红（PR #653 在 69ea566 上的 windows-package），产品代码没动。
