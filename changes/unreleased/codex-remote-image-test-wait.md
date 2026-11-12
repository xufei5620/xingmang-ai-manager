## 开发

- 修 Windows CI 上 `codex-remote-service.test.ts`「holds images until the next prompt…」偶发红（`expected false to be true`，
  第 1810 行「有 .png 也有 .jpg」那句）：用例只等到假渠道取过第二张图就去看目录，那时 `store.save` 的原子写还没换名，
  目录里是一张 png 加一个 `.….jpg.<uuid>.tmp`。`setup()` 新增 `imagesSaved(count)`，包一层真的图片存放处、等第 count 张存好；
  「关遥控删光图片」那条（`toHaveLength(1)` 会被临时文件凑上）和「新对话扔掉攒着的图」那条同样改成等存好。被测代码和断言没动。
