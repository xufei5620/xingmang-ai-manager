## 用户

- 工具检测没成功时，「安装卸载」页不再把它写成「未安装」，而是显示「检测失败」和具体原因，避免对着一个其实装好了的工具反复点安装。
- 版本号无法解析、或已安装版本高于更新源时，「安装卸载」页会说明这次为什么没能判断有没有新版本。

## 开发

- A4：新增 `toolAvailability` 与 `updateCheckFailure` 两个纯函数（`src/renderer-v2/features/tools/model.ts`），把「探测失败 / 状态未读到 / 已安装 / 未安装」四态和 `buildCliStatus` 早就写好的两条更新检查失败原因映射成行上的文案，原因先过 `snapshotErrorMessage` 脱敏（I13）。
- `pages-maintenance.tsx` 的工具行改用 `features/tools/ToolStatusMeta.tsx` 的 `ToolStatusMeta` / `ToolStatusReason`，探测失败时版本位显示「版本未读到」而不是「未找到版本」。没有引入 broken 第三态（清单 §5）。首页工具行的 `detail` 在 A1 里已经带出 `detectionError`，未重做。
