# 无限画布预览与变更交付

本文补充画布的预览方式和交付证据，不修改任何运行时代码，也不替代 [CLAUDE.md](../CLAUDE.md)、[协作规范](./COLLABORATION.md) 和当前任务的用户授权。UI 重建的验收与提交限制继续有效；允许创建某个草稿 PR，不代表允许合并、发布或执行真实付费生成。

## 1. 三种验证结果必须分开

| 层次 | 用途 | 不能据此声称 |
|---|---|---|
| 浏览器演示 | 检查画布布局、节点编辑、面板和本地演示交互 | 生产账号、模型请求、Electron IPC、项目落盘已经通过 |
| 自动化测试 | 验证所执行用例覆盖的逻辑；使用 mock 和隔离数据 | 未执行的平台或真实服务已经验收 |
| 桌面端验收 | 在对应 Windows/macOS 环境验证宿主、文件系统和账号生命周期 | 另一平台也已通过，或安装包已经发布 |

浏览器演示不读取生产会话、不签发分组 Key，也不执行真实 AI 请求。生产路径由 Electron 主进程负责凭据、模型请求和资产操作。参见 [画布说明](../canvas-v2/README.md) 与 [架构计划](./CANVAS-V2-PLAN.md)。

## 2. 从仓库根目录预览

以下命令使用根目录的锁文件和依赖；它们是操作步骤，不是已经执行通过的报告。先切换到需要预览的分支，并核对该分支的提交 SHA。

首次准备依赖：

```bash
npm ci --registry=https://registry.npmjs.org/
```

启动画布浏览器开发预览，显式使用当前 renderer-v2 的主题 token：

```bash
npx --no-install cross-env XINGMANG_RENDERER=v2 vite canvas-v2 --config canvas-v2/vite.config.ts --host 127.0.0.1 --port 5175 --strictPort
```

在运行该命令的同一台机器上打开 `http://127.0.0.1:5175`。端口被占用时命令会失败，不会静默切换到另一个地址。此命令只启动画布前端，不启动 Electron。

预览构建产物：

```bash
npx --no-install cross-env XINGMANG_RENDERER=v2 npm run canvas:prepare
npx --no-install cross-env XINGMANG_RENDERER=v2 vite preview canvas-v2 --config canvas-v2/vite.config.ts --host 127.0.0.1 --port 4175 --strictPort
```

在同一台机器上打开 `http://127.0.0.1:4175`。构建会生成 `canvas-v2/dist/`，并复制到 `dist-canvas/`；不要提交这些产物。

命令依据：[根 package.json](../package.json) 和 [画布 Vite 配置](../canvas-v2/vite.config.ts)。不要把根项目的 `npm run preview` 当成专门的画布预览命令，也不要把开发服务器当成生产部署。

## 3. 变更如何进入仓库

获得当前任务的提交授权后，从重新核实的 `main` 提交创建独立分支。修改现有文件前读取该分支文件及其当前 blob SHA，避免覆盖他人的新改动；多文件变更应尽量保持一个可审查的原子提交。

PR 应写明实际开发者、AI 工具、执行环境、变更范围和验证证据。未完成验证时保留草稿并列出缺口，不勾选未运行的检查，不修改测试断言或分支规则来绕过验收。创建 PR 后再读取 PR 和差异，确认 head/base、文件范围与预期一致。

GitHub 写入权限与运行环境是两条独立链路：能提交文件，不代表当前环境已经能运行 Electron；创建 PR 也不会自动产生在线预览地址。

## 4. 每轮交付的最小证据

- 代码：分支、提交 SHA、PR 和实际修改的文件。
- 预览：截图或可操作的预览产物，注明对应提交、运行方式以及哪些业务结果是模拟的。
- 验证：实际运行的命令、平台和结果；未运行、失败、跳过与通过分别记录。

涉及画布逻辑时，按改动范围执行现有检查，例如 `npm run typecheck`、`npm run test:canvas`、`npm test`、`npm run compile`，以及具备所需原生环境时的 `npm run test:canvas:visual`。这些命令的存在不代表本次已执行；桌面和真实服务验收仍需单独记录。

截图、构建产物、运行日志和预览包不混入源码提交。共享前检查账号资料、凭据、私有素材和本机路径；预览只能使用可公开的演示数据。

## 5. 在线预览的边界

`127.0.0.1` 地址只能用于运行预览服务的本机，不能发给其他人充当在线预览链接。需要远程访问时，另行配置经授权的静态预览托管，只部署画布前端产物，不部署 Electron 主进程、账号文件或凭据。

浏览器演示、在线预览和正式桌面发布互不替代。没有实际部署结果时，不宣称已提供在线地址；没有对应平台验收结果时，不宣称已修复桌面端行为。
