## 开发

- Linux 版拆分第 ⑥ 步：没有可用的系统密码保管（safeStorage 不可用或只有 basic_text）时照样能登录，
  只是不记住。`resolveCredentialPersistence`（safe-storage-backend.ts）只在 Linux 上给出
  `session-only`：账号库换成只在内存里的 `createSessionRealmAccountVault`，托管 CLI Key 与 AI 聊天
  分组 Key 两个缓存也只放内存，一个字节都不落盘（I3 不变）；旧版 saved-accounts / account-session
  文件不读也不动。会话状态带 `sessionOnly: true`，renderer-v2 的登录框与设置页据此不给「记住密码」，
  改说「关掉软件后要重新登录」。Windows、macOS 加密不可用时照旧拒绝登录。
- 桌面环境 Chromium 不认识（i3、LXQt、远程桌面、deepin 新版的 DDE 等）但装了 gnome-keyring
  （有 `org.freedesktop.secrets` 的 D-Bus 激活文件）时，ready 之前给 Chromium 加
  `--password-store=gnome-libsecret`（linux-password-store.ts）；认识的桌面、有 KDE 迹象、用户自己
  传了该开关时都不动。
- 拒绝写入时的提示去掉「密钥环」「凭据服务」「明文」这类词。
