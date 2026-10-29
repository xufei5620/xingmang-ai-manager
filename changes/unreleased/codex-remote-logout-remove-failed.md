## 开发

- 手机遥控：「退出登录」删不掉保存的凭据时不再当成功（#1407 P3-6）。`CodexRemoteStore.writeCredential(channel, null)` 原来把
  `removeSafeDataFile` 的失败 `.catch(() => undefined)` 吞掉，凭据文件还在、下次打开照样登着。现在除了查完就没了的 ENOENT，
  删不掉一律抛「没能删掉保存的登录信息，请重启星芒后再点一次退出登录。」，原错误挂在 cause 上进运行日志。
  `saveChannelCredential` 在退出登录这条路上碰到它，照旧解绑、停掉渠道，账号字样留着（凭据还在，卡上照旧能再点退出登录），
  先推一份快照让界面跟上，再把那句报出去；保存新凭据失败照旧原样抛。
