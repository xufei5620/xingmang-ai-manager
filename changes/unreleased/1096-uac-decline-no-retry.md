## 用户

- Windows 上装 Node.js 时，在管理员授权窗口点了「否」，或者这个账号拿不到管理员权限，星芒就停下，
  不再换一个下载源又弹一次授权。错误框标题改成「没拿到管理员授权」，配「重试」「找客服」；
  普通账号会看到「需要输入一个管理员账号的密码 / 公司或学校的电脑请联系 IT」这句，不再被一句泛话盖掉。

## 开发

- #1096：`electron/node-runtime.ts` 的 `errorText` 遇到 `runUacProcess` 按账号类型写好的两句
  （`windowsElevationCancelledMessage` / `windowsElevationDeniedMessage`）原样保留；换源循环认出这两整句就停；
  `describeNodeInstallFailure` 把「未获得管理员权限」也排进第一档（以前落到「原因已经记进运行日志」）。
  只认这两整句，不认 errorText 按「取消」「cancelled」猜出来的那句，免得网络错被当成客户拒绝、备用源轮不到。
  提权本身、可信路径、命令执行都没动。
- 渲染层 `operation-error.ts` 加 `elevationDeclined` 一类（排在 permission 前），`registry/errors.ts` 用
  「要你点头」A 组已批的字；新手引导 `StartGuide.tsx` 认出这一类后把原话后半截的下一步接在红字里，
  不再只折在「给客服看的原话」里。
