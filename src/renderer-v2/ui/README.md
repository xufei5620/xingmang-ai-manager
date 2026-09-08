# Renderer v2 UI

组件由 core、fields、modal、floating、feedback、brand、guidance 分担实现；每个契约组件通过同名目录的入口导出，页面统一从 `ui/index.ts` 导入。组件拒绝页面传入 className / style；尺寸、语义色与版式使用规范 Token。

组件预览入口：`src/renderer-v2/gallery.html`。查询参数 theme=light/dark 与 os=win/mac 仅用于本地检阅。运行浏览器测试：`node --test src/renderer-v2/ui/browser-check.mjs`。Vitest 的 renderer-v2 project 使用 React 19，legacy project 隔离使用 React 18。

- Button 保留原生 type/form/disabled/ARIA，默认 type=button，表单显式 type=submit。
- Tabs 默认手动激活：左右/Home/End 移焦，Enter/Space 切换；本地设置面板可显式 activation=automatic。Segment 使用 group/aria-pressed 并自动激活。
- Dialog/Drawer 使用原生 showModal 约束背景与焦点，dirty 时遮罩不关闭，Esc/关闭按钮显示保留草稿的放弃确认。业务异步期间必须传入 busy。主动保存成功仍由业务关闭。
- Menu/Popover 使用原生 manual popover，保留所属 Dialog DOM 和焦点链，支持 Esc、外部关闭与触发器焦点返回。
- Logo 使用 Vite 静态资源；模型品牌按需导入 lobehub，运行环境使用 simple-icons，功能图标使用 Lucide。
- Toast 最多 3 条，每条 2.4 秒，使用递增 ID，卸载清理计时器。重要错误仍应留在当前页面。
- 根应用调用 useReducedMotion() 以同步系统减少动画；也支持 data-reduce-motion=1。

当前证据：10 组独立 Playwright 交互检查、4 张 Win/Mac 样式 × 明暗截图、3 项 SSR 契约检查。另有 16 组按钮、卡片、输入和状态材质的原型计算样式比较，差异为 0；不代表所有页面逐像素相同。Tooltip 支持聚焦及 Esc；Coachmark 不指向隐藏目标，可以逐步继续或跳过。按用户“原型优先”的规则，焦点外环采用原型的 --info，输入边框仍按原型使用 --accent。
