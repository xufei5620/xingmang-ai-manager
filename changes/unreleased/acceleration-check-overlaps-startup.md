## 用户

- 打开软件时，加速组件的安全校验和其它启动准备同时进行，慢电脑上主窗口能早一点出来。

## 开发

- 全面检测 Q20。`main.ts` 原来在建窗口前单独 `await readBundledAccelerationConfig`（整读三十多兆内核算 SHA-256）。改为拿到 `managerDataDirectory` 后立即发起读取、先把失败接成结果对象（避免等待期间被当成未处理的拒绝），原位置再等结果。校验内容与失败处理不变；内核启动前 `acceleration-mihomo-runtime.ts` 对拷贝出来的内核仍会再校验一次。
