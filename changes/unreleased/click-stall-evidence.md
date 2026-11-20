## 开发

- 浏览器用例的点击停在 `performing click action`（11-11 #1756、11-20 #2003 两次，都在 Windows
  `renderer-v2-e2e`）时，`e2e/click-stall.mjs` 当场并排探一遍：卡住的页面还回不回话、还出不出帧、
  新的鼠标移动有没有回应、同一浏览器新开页能不能点、Node 事件循环和整机 CPU，结果接在报错后面，
  截图进 `artifacts/click-stall/`，Windows 作业红了上传成 `click-stall-<分片>`。经 `e2e/harness.mjs`
  开的页面都带上；`e2e/click-stall.test.mjs` 真做出一次卡住的点击来核对。怎么读见
  `docs/TEST-BASELINE.md`「点击停在 performing click action」。
