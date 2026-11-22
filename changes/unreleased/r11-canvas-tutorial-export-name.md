## 开发

- 给客户看的那句并进了 `home-corner-notices.md`（0.2.25 更新说明统一改为正式书面口吻、同类并条，复查第三轮第 8 条）。
- `src/renderer-v2/registry/tutorials.ts` 画布章最后一步原来叫客户在「更多操作」里选「导出项目（含素材）」，
  但这个入口只在宿主接了网页便携包导出（`host-entry-points.ts` 的 `projectPackageExport`）时才出现，桌面画布没接，
  菜单里只有「导出工作流」；它走 `canvas-host:export-project`，导出的文件内嵌图片，视频和音频不带（`canvas-project-package.ts`）。
  改成「导出工作流，图片会一起导出」；`tutorials.test.ts` 读画布菜单源码和桌面画布 preload，把按钮名钉住
  （Mac 验收 R11，报告 #1736，0.2.25 总单第 53 项）。
