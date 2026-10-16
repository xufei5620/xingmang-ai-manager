## 开发

- UI v4 批05 工具配置弹窗（`features/tools/ConfigDialog.tsx` 整个重写）：去掉工具页签，`App.tsx` 点开哪个工具就开哪个的配置；
  来源改成三张单选卡（`features/tools/dialog-parts.tsx` 的 `RadioCards`，`role="radio"` + `aria-checked`，方向键换选中），访问密钥
  改成带第二行说明的下拉（`features/tools/OptionPicker.tsx`，选中值挂在按钮的 `data-value`，每项 `tool-key-select-option-<值>`），
  `key-selection.ts` 的 `accountKeyLabel` 换成 `accountKeyDescription`，新增 `manualKeyIssue`（星芒站 `sk-` 开头、20 位以上）。
  原来的 `tool-save-detect-models` 并进主按钮 `tool-save-config`（没改动「完成」、没检测「保存并检测」、其余「保存配置」）；
  重置的确认从单独的确认框挪到「高级」里原处（`tool-save-reset` → `tool-save-reset-confirm`）。Codex 桌面端的语言与文件夹权限
  展开时读一次，「检查中文界面」去掉。保存成功的提示按 `ConfigSaveOutcome`（保存 / 重置 / 换成官方账号）写出工具名；配置弹窗只写
  文件、不做连接自检，所以不说「自检通过」。
- `ui/modal.tsx` 加 `useDialogClose()`：框里的「取消」、去别处的链接（管理密钥、查看配置备份、查看 ChatGPT 账号额度）和点 × 一样，
  有修改先亮离开条，`after` 等真关了才跑。`ui/core.tsx` 的 `Segment` 加 `activation`（Codex 界面语言选了就重开 Codex，方向键不能触发）。
- Codex「换用别家模型」改成单独的 `OtherModelsDialog.tsx`：只用工具里现在那把当前账号的密钥（主进程沿用通道，空 apiKey），
  用 ChatGPT 账号或别的来源时先走一键改用当前账号；`model-filter.ts` 的 `codexModelFilterSaveIssue` 换成 `otherModelChoices` /
  `otherModelSaveIssue`。ChatGPT 账号额度抽成 `OfficialQuotaDialog.tsx`，首页「…」和配置里都开它；配置里打开时先关配置，同一时间
  只开一个弹窗。
- 外接工具弹窗（`ExternalClientDialog.tsx`）同一个样子：标题按首页是否连好写「连接 {名称}」或「{名称} 配置」（`external-model.ts`
  的 `externalClientReady`），名称旁写版本；「保存并检测」拿得准型号（原来就配着的、Claude Desktop 认得出的 Claude）就接着保存；
  连好后右下角说下一步。关闭时原来的「放弃未保存的修改？」确认框换成弹窗底部的离开条（配置弹窗同）。
- 界面文字照 `界面文字/批05-工具配置弹窗` 改（yoyo 2026-10-15 回「全部按推荐改」），来源一律写「当前账号」；教程里指到配置弹窗的
  说法跟着换（「使用星芒账号」→「当前账号」、「访问密钥」、「保存并检测」、「启用中文界面」）。浏览器测试跟着新结构改（页签、
  确认框、`selectOption` 改下拉菜单），加「配置里打开 ChatGPT 额度」一条；fixture 补 `inspectCodexWorkspacePermissions` 和
  `?officialEmail=1`。`e2e/macos-visual-qa.mjs` 和 `scripts/audit/renderer-v2-gap-audit.mjs` 不再找工具页签。
