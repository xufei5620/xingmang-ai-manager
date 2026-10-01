## 用户

- 开机时暂时连不上账号服务、登录还在的那段时间，底部状态栏和首页余额卡不再写「未登录」「登录后查看用量」，和左下角说法一致。
- 首页「最近」里 Codex 定时任务的记录只显示任务名，长标题截成一行，不再撑破卡片。

## 开发

- `Shell.tsx` 状态栏未登录时沿用 `account.displayName`（恢复中 / 联不上等重试时 App 放的是「正在恢复登录」「暂时连不上，登录还在」）；`Home.tsx` 新增可选 `accountRestoring`，App 按 `sessionRestoring` 传入。
- `provider-sessions.ts` 新增 `codexSessionTitle`：Codex Automation 的标题（「Automation: 名字 Automation ID: …」整段任务说明）只留任务名，其余标题折成一行、限 160 字；首页「最近」标题加单行省略号。
