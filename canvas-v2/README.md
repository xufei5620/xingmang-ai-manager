# 星芒无限画布 v2（节点式 AI 媒体工作流）

架构、安全边界和验收门禁见 [`../docs/CANVAS-V2-PLAN.md`](../docs/CANVAS-V2-PLAN.md)，第三方来源见 [`../docs/CANVAS-THIRD-PARTY.md`](../docs/CANVAS-THIRD-PARTY.md)。

> **落点说明**：v2 位于主仓 `canvas-v2/` 目录；根项目的 `npm run canvas:prepare`
> 会用根构建依赖生成并复制 `dist-canvas/`。本目录仍可独立安装依赖和开发。

## 开发

```bash
cd canvas-v2
npm install
npm run dev        # 浏览器演示模式：文件走下载/选择，不连接生产服务
npm run build      # tsc + vite，产物在 dist/
```

浏览器演示模式不读取登录会话、不签发分组 Key，也不执行真实 AI 请求；桌面宿主中的分组协调、主进程运行服务和账号资产隔离才是生产路径。

从仓库根目录运行四视口 Electron 视觉门禁：

```bash
npm run test:canvas:visual
```

## 当前状态（生态增强 v1）

- 10 类核心媒体节点、类型化端口、节点注册表和未知节点降级占位。
- Undo/Redo、复制/粘贴/重复、分组/解组、自动布局、资产拖入和三套原创模板。
- 主进程 DAG 运行服务：有界并发、取消、缓存、运行历史、候选预览/采纳、下游增量失效。
- 支持全部、仅变更、选中链路、运行到节点四种运行范围；采纳候选只标记下游为待更新，不自动触发付费任务。
- 当前账号专属的本地资产库，存放在安装根目录 `output/`，支持重启恢复和右键操作。
- Schema v2、v1 迁移、敌意输入修复，以及可携带本地图片的有界 `.xingcanvas` 项目包。
- 默认暗色画布，首帧、节点、媒体区、Controls 和 MiniMap 使用同一主题。

## 桌面宿主边界

- 画布 renderer 运行在独立 sandbox 窗口中，CSP 禁止网络连接。
- API Key、access token、refresh token 和供应商请求只存在于 Electron 主进程。
- 桌面资产按当前登录用户隔离，账号切换会取消旧账号的在途任务。
- `.xingcanvas` 导入由主进程预览、校验、暂存和提交；浏览器模式只提供轻量 JSON 兼容格式。

## 开发纪律

- 测试绝不对生产 `xm.solov.cc` 发真实请求（T12）；引擎和模型层保持零框架依赖，便于纯函数测试。
- renderer 不接触 API Key、session token 或生产 API；所有 AI/资产操作经独立、有界、校验 sender 的宿主 IPC。
- 产物必须使用相对路径（`base: './'`，受自定义协议加载约束）。
- GPL/AGPL、限制许可和无许可证来源只作 idea-only 调研；React Flow Pro 付费示例不复制。
