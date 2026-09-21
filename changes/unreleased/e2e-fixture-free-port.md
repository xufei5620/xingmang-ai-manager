## 用户

- 无

## 开发

- e2e 夹具的 Vite dev server 改为先向内核预约一个空闲端口、再用 `strictPort` 钉给 Vite。
  此前各处传的 `port: 0` Vite 并不认（`startServer` 把 0 当成「没配端口」），实测 8.1.5
  上三个 server 依次落在 5173 / 5174 / 5175，等于所有夹具都从同一个众所周知的端口起步，
  与本机的 `npm run dev` 抢同一段号。
- 八处各自 `createServer` 的夹具 server（`app-check` / `ui` / `auth` / `chat` /
  `acceleration` / 两个 shell 公告套件 / `macos-dev-origin`）统一改走
  `e2e/harness.mjs` 的 `createFixtureServer()`，端口一律从它返回的实际绑定结果取。
- `scripts/ci-workflow-config.test.cjs` 里按「内核分配端口」写的断言口径是错的，改成钉住
  预约 + `strictPort`，并扫描 `e2e/` 与 `src/renderer-v2/` 下新增的自起 Vite server；
  另加一条「连开八个夹具 server 不会拿到同一个端口」。画布套件按冻结约定登记为豁免。
