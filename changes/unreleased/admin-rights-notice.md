## 用户

- 检查页的「运行权限」这一项，除了原来的「当前以普通用户权限运行」，还会多看一眼
  这个 Windows 账号在不在管理员组：不在的话提前标成「需留意」，写明自动安装
  Node.js 和 Codex 桌面端时会要管理员账号的密码，公司或学校的电脑请联系 IT，
  也可以请 IT 先装好 Node.js LTS 再回来点「重新检测」。以前这一项对普通账号永远
  是绿的，完全看不出这台电脑其实装不了 Node.js。macOS 不变。
- Windows 上装 Node.js、装 Codex 桌面端失败时的提示分开说了：自己在授权窗口点了
  「否」是一句（再点一次安装即可），账号本身没有管理员权限是另一句（要输入一个
  管理员账号的密码）。以前两种都只写「重新授权」，而对后者再点一次也一样进不去。
- 软件自己仍然始终以普通权限运行，这次只是把要授权的地方讲明白。

## 开发

- `electron/windows-elevation.ts` 新增 `inspectWindowsElevationCapability()`，回答的是
  「这个账号能不能提权」，与既有的 `inspectCurrentWindowsProcessAdministrator()`（「现在
  是不是管理员在跑」）是两件事：UAC 过滤后的令牌里 `BUILTIN\Administrators` 仍在 Groups
  列表里（deny-only），所以普通进程也问得出组成员身份。按 SID `S-1-5-32-544` 比对，
  不受 Windows 显示语言影响；探测失败一律返回 `'unknown'`，绝不因此挡住安装或自检。
- 同一文件新增 `windowsElevationCancelledMessage` / `windowsElevationDeniedMessage` /
  `windowsStandardAccountAdvice` 三个纯函数，`node-runtime.ts` 的
  `nodeRuntimeElevationFailureMessage` 与 `codex-desktop-appx.ts` 新抽出的
  `codexDesktopElevationFailureMessage` 共用它们，退出码 1223（取消）与 740（没拿到权限）
  在拿到 `'standard'` 时换文案。两处只在这两个码上多花一次探测。
- `diagnostics.ts` 的 `ADMINISTRATOR` 项加可注入的 `inspectElevationCapability`，
  只在 `platform === 'win32'` 且当前不是管理员时问；`details` 多一个 `canElevate`
  （`true` / `false` / 探不出来时 `null`）。macOS 走原路径，输出一个字没变。
- 不做「以管理员身份重试」（已定不做），也不做免管理员的用户级 Node——那会撞
  `node-runtime.ts` 的受保护路径校验。第七批候选 4 的一半；「点安装前先说一句」
  那半要落在首页与「安装卸载」页，为避开在飞的界面改动推到下一版。
