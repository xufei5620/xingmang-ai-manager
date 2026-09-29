## 用户

- 新手引导里装工具、准备运行环境、改用当前账号失败时，红字不再只剩「没装上」：认不出原因的会说一句「原话在下面」，系统原话折在「给客服看的原话」里；旁边多了「复制给客服」，一次复制账号、版本、系统、时间、引导里的哪一步和原因，密钥自动打码。点「需要帮助」时，帮助框的「最近一次出错」也会有这一条。

## 开发

- 第二十一批 1：`StartGuide` 的失败从一句字符串扩成 `GuideFailure { message, reason, detail }`（`guideInstallFailure` / `guideStepFailure`，替掉原来的 `guideInstallErrorMessage` / `guideStepErrorMessage`）；原话走 `business-common.tsx` 新导出的 `supportDetailOf`（`operationFailureFrom` 同用这一份）。新增 `support`、`onFailure` 两个 prop，App 传 `supportInput` 与 `setLastFailure`；复制内容复用 `buildSupportBundle`。原样上屏的中文原因现在也过 Key 打码表。
