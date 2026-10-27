## 开发

- 依赖（仓库优化 G4）：删掉 `@lobehub/icons`。界面只用它 11 个 AI 厂商图标，它却把 `antd`、`@lobehub/ui`（连带 mermaid、shiki 等）写成 peer 依赖，锁文件里 970 个条目有 443 个只因为它才装。这 11 个图标的 SVG 原样抄进 `src/renderer-v2/ui/vendor-icons.tsx`（MIT，文件头留出处），路径、颜色、`<title>`、渐变 id 的写法都没变：删之前逐个对过，各种尺寸和传参下渲染出来的 SVG 与原来的包逐字节相同，`BrandIcon` 对所有工具、客户端和常见型号名的输出也相同。锁文件只删条目，留下的包版本和校验值一个没变。`katex` 的 `overrides` 当初是为这条依赖链加的，现在不起作用，没动。
