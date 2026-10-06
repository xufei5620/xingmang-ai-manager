## 用户

- 改用当前账号、重新写入 Key、保存配置、密钥页「配置到工具」、恢复备份、改扩展时没权限写进去，提示改说「写不进配置文件」，
  告诉你常见是安全软件拦了或文件正被别的程序占着，给「重试」「找客服」；不再叫你去查安装目录、复制安装目录的路径。
- 新手引导里点「改用当前账号」写不进配置文件时，也改说「写不进配置文件」，告诉你关掉正在用这个工具的窗口后点「再试一次」，
  还不行就点「复制给客服」；复制给客服的原因跟着改。按钮不变。

## 开发

- 已知29：`registry/errors.ts` 加 `configPermission`；`operation-error.ts` 的分类、`presentOperationError` /
  `presentOperationFailure` 多收一个可选的 `target: 'config'`，只把 `permission` 换成它（文件被占用、搬过的文件夹、
  磁盘满不动）。接上的地方：App `perform` 按动作名（`operationTargetOf`：改用当前账号、切回官方账号、重新写入 Key、
  修提醒设置、重置为初始状态）、配置窗口红字、扩展页（除「安装 Python」）、备份页恢复和密钥页「配置到工具」
  （`useOperation` 新增 `failed` 记下是哪个动作失败的）、`keySyncFailureReason`（首页「账号 Key」那行、
  切换账号后没同步的工具）。
- 已知29（新手引导）：`StartGuide.tsx` 的 `guideStepFailure` 按动作名（`operationTargetOf`）分类，`configPermission`
  单独一句，把目录里的「重试」「找客服」换成引导里的「再试一次」「复制给客服」（没有复制按钮时是「需要帮助」）；
  `guideFailureExits` 不传 target，出口照旧是「查看日志」。浏览器夹具加 `switchDenied`。
