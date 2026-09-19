## 开发

- 修复 `npm run release:build:unsigned` 里 `npm test` 必挂的一处环境继承：`scripts/macos-build-config.test.cjs`
  与 `scripts/update-release-utils.test.cjs` 有十处 spawn 直接摊开 `process.env`，把门禁自己设的
  `XINGMANG_UNSIGNED_RELEASE=1` 带给了加载 `electron-builder.config.cjs` 的子进程，配置于是在用例断言
  之前先抛「两种发布模式不能同时启用」，五条用例一起红。改成从一份删掉构建模式变量的环境出发，并加一条
  用例钉住这一点。`BUILD_MODE_ENVIRONMENT_NAMES` 随之从 `scripts/run-macos-free-build.cjs` 导出，
  并补进调试放行开关 `XINGMANG_ALLOW_UNSIGNED_RELEASE`（只加禁止项，不放宽 P-24 的清洗）。
