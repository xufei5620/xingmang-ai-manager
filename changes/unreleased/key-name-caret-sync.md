## 开发

- 密钥页名称框（`pages-account.tsx` 的 `changeName`）截名字后不再用 `requestAnimationFrame` 挪光标，改成当场把截过的名字写回输入框再
  `setSelectionRange`，React 随后核对时值已相同、不再改写。以前打满 16 个字后被拒的那一下排了一个「光标放回原处」的下一帧回调，
  紧接着按 Home、→ 时它才跑，把光标拽回末尾；`e2e/v2-business.test.mjs` 的「a Chinese key name stops at 16 characters…」因此偶发红
  （本机改前连跑 12 次红 4 次，改后单跑 30 次加三路并行 30 次全绿）。界面字不变。
