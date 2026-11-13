## 开发

- 下载注册页（`dl-landing/`）的老版紫光四角星换成 v3 深蓝金色星芒，跟装好以后看到的程序图标一样：`logo.png` 换成 `assets/brand/v3/favicon.ico` 里 256px 那张，标签页图标改用同一份 `favicon.ico`（原来是那张 270×269 的黑底图），四处引用都加 `?v=brand-v3`，免得 CDN 接着给老图；`scripts/dl-landing-install-guide.test.cjs` 核对两张图跟品牌素材逐字节一致（图标审查 IC-11）。页面配色和文字没动。只改仓库，要把 `index.html`、`styles.css`、`logo.png`、`favicon.ico` 传上下载站才上线。
