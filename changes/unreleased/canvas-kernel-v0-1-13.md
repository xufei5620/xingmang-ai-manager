## 用户

- 画布运行前检查的提示更加清晰，可沿用上次结果的节点将注明通常不会产生扣费；节点较多时拖动更流畅。

## 开发

- 画布内核同步到 xingmang-canvas kernel-v0.1.13（ece6fcf，`scripts/sync-canvas-kernel.mjs` 按 tag 原样同步，没有本地补丁），带进 0.2.25 总单第 54~59 项六个 PR，桌面主进程都不用跟着改：
  - xc #51（总单第 54 项，Mac 验收 R12）：运行前检查里没提示词、前面节点跳过、宿主不支持前面的节点、图片编辑没连图四句原因和两个范围说明，以及同一句话的运行菜单、选中工具条说明，把「上游」换成「前面连着的节点」这类说法；`reasonCode` 不变。
  - xc #52（总单第 55 项，Mac 验收 R13）：`image-tools/image-mask-workflow.ts` 的 `imageMaskConfigurationError` 原来把没连图、连了两张或整组、原图换了合成一句「原图已变化或不是唯一单图，请重新核对蒙版」，主进程 `ai-image-service.ts` 的「局部修改只能用一张原图」被内核先拦下走不到。拆成三句，连两张或整组那句跟主进程逐字一样；拦的条件不变。
  - xc #53（总单第 56 项，Mac 验收 R14）：内核 `imageMaskConfigurationError` 拦不支持蒙版的模型时少了「；不会改为整图生成」，整句提成 `image-edit-mask.ts` 的 `imageEditMaskUnsupportedModelMessage`，跟 `assertImageEditMaskInput` 共用。
  - xc #54（总单第 57 项，Mac 验收 R15）：运行前检查给 `cachedNodeIds` 里照常执行的付费节点标 `keptResult`、算 `keptResultRequestCount`，确认框那段话由 `canvasRunPaidNotice` 拼；上限 `paidRequestCount`、`cacheHitCount`、报价都不变（桌面证明不了指纹时照样重新生成，靠的就是确认框写了上限）。
  - xc #55（总单第 59 项，11-18 复核 A04）：`validateAccountAssetPage` 不再把落在总数后面的空页当坏回包，`AccountAssetLibrary` 退回最后一页那段才走得到；退回哪页提成纯函数 `accountAssetStepBackOffset`。主进程 `listOwnedPage` 越界本来就回空页。
  - xc #56（总单第 58 项，Mac 验收 R16）：归档框打开时把焦点交给「确认归档」，处理失败回来时再放回去；改名、复制框照旧由输入框拿焦点。
