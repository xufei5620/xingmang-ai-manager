## 开发

- 创作起始页说明排成一行（yoyo 2026-11-26 回「说明排一行」，方案第 3 条，纯版面）：`chat.css` 里 `.chat-empty[data-start='true'] p` 的 `max-width` 460px → 520px。
  原来这句正好差一点放不下，「账号。」掉到第二行，#2163 的 `text-wrap: pretty` 在这里没起作用。`app-check.mjs` 加一条：1280 × 820 和 1100 × 680（侧栏收成窄条后）都只有一行，改前会红。
