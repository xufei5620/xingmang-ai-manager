## 用户

- 发布方发现旧版本有严重问题时，可以要求先更新再用：打开软件会看到「这个版本需要更新后才能继续用」，点「立即更新」就会自己下载并装好，中间重启一次，账号和设置都保留。更新不成功时可以重试、打开下载页手动装，或者直接联系客服。

## 开发

- 更新目录的 `service-status.json` 新增 `minimumVersion`（`electron/service-status.ts`）：本机低于它时更新快照带上 `requiredVersion`（`resolveRequiredVersion`，`electron/updater.ts`），刚变成必须更新时补查一次；渲染层 `features/app/RequiredUpdateGate.tsx` 盖一层关不掉的提示，只留更新、联系客服，失败时加「打开下载页」（GitHub Release 最新版，已进外链白名单 `electron/app-download-page.ts`）。
- 不会把人困住的几道闸：状态文件读不到或字段写错当没有最低版本；检查结果是「没有新版本」（定得比线上还高、被撤回）或找到的是退回版本时不拦；低于最低版本的电脑检查时不受分批放量限制；开发态和本地构建不拦。service-status 工作流新增「最低版本」输入，设之前读线上 `latest.yml` / `latest-mac.yml`，高于线上正在发的版本就拒绝。
- 只有带这段代码的版本（0.2.11 起）认这一项；0.2.8、0.2.9 不读状态文件，0.2.10 读但不认新字段。旧界面（已冻结）不显示这层提示。
