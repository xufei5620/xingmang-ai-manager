## 开发

- 画布目录自带的那份依赖清单和锁文件换成跟根目录同一套（D102，`安全.md` 新-2、`依赖.md` DEP-8）：
  原来 100 项里 88 项从国内镜像解析、React 还是 18，`npm audit` 报 4 条（vite 8.2.1、source-map-js 1.2.1、
  vitest 4.1.10）。现在 `canvas-v2/package.json` 的范围照根目录写（React 19.2.8，补上 `@types/node`），
  `canvas-v2/package-lock.json` 由新脚本 `scripts/trim-canvas-lockfile.cjs` 从根目录锁文件原样裁出 106 项，
  全部来自 npm 官方源、带 SHA-512，审计 0 条。画布照旧用根目录依赖构建，安装包不变。
- `docs/canvas-third-party.json` 和 `docs/CANVAS-THIRD-PARTY.md` 的 React 记成实际发出去的 19.2.8；
  `verify-canvas-provenance.test.cjs` 新增一条：画布清单的范围要跟根目录一样，锁文件要正好是从根目录裁出来的那几项，
  根目录升了画布用到的包就会红，照提示重新裁一次。
