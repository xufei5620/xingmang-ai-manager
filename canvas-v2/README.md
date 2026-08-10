# 星芒无限画布 v2(节点式 AI 媒体工作流)

总规划见 [`../docs/CANVAS-V2-PLAN.md`](../docs/CANVAS-V2-PLAN.md),进度跟踪见 issue #80。

> **落点说明**:v2 暂居主仓 `canvas-v2/` 目录(独立 package,与主应用零构建耦合)。
> 老板确定最终仓库后整体平移,主仓侧只需把 `XINGMANG_CANVAS_DIST` 指向新产物路径。

## 开发

```bash
cd canvas-v2
npm install
npm run dev        # 浏览器独立开发(无宿主桥时自动降级:文件走下载/选择,token 为空走 mock)
npm run build      # tsc + vite,产物在 dist/
```

## 当前状态(M0 骨架,已完成)

- 三种节点(文本/图像/视频),节点即 React 组件:提示词、模型名、状态灯、结果预览、失败原因、消耗展示
- 类型化端口(text/image/video)+ 连线校验:类型不匹配拒绝、方向拒绝、成环拒绝(`ports.ts`)
- 客户端 DAG 执行引擎(`engine/engine.ts`,纯函数、主仓 vitest 直接测):拓扑排序、就绪即触发、
  上游失败下游跳过、整图取消;M0 用 mock 执行器演示全链路
- relay 客户端骨架(`engine/relay.ts`):端点已按 rc.24 源码钉死(文生图直调 + 视频任务提交/轮询),
  **渠道配置好后把 App.tsx 的 executors 从 mock 换成真实现即进入 M1**
- 工作流 JSON 持久化(保存/打开,经宿主桥或浏览器降级;敌意输入校验)

## 纪律(与主仓同源)

- 测试绝不对生产 `xm.solov.cc` 发真实请求(T12);引擎/模型层保持零框架依赖便于纯函数测试
- 宿主能力面只减不增(I15);产物必须相对路径(`base: './'`,自定义协议加载约束)
- Jaaz 零代码引用;React Flow Pro 付费示例不抄
