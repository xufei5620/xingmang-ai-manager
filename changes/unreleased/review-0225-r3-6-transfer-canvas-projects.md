## 开发

- 0.2.25 第三轮复查第 6 条（「画布也搬」，yoyo 2026-11-22）：「迁移到新电脑」以前只带画布项目里生成的作品，项目本身（节点和连线、
  项目里导入的素材）不带，界面上也没说。现在选「导出全部」时连项目一起带：导出文件夹里多一个「画布项目」文件夹，一个项目一个子文件夹
  （`workflow.json` + 照项目素材布局放的文件），清单 `xingmang-canvas-projects.json` 最后写。项目里生成、已在「作品」里的那几件只记编号，
  不复制两份。归档的项目照带、导过去仍是归档；旧版没选文件夹的项目导过去也不绑文件夹；文件夹连不上的项目不导、询问框里说几个
  （`electron/data-transfer-canvas.ts`）。
- 导入时项目先于作品：每个项目在「文档 › 星芒画布」新建一个文件夹（同新建项目，`claimCanvasDefaultProjectFolder`），文件逐个核对后放进去，
  再以原编号、原时间登记（`canvas-project-store.ts` 新增 `listTransferable` / `admitTransferred` / `restoreTransferred`）；登记失败删掉这次放的文件、
  交还文件夹，列表里不留半个项目。同编号已在本机的算已存在，导两次不多一份；本机项目到上限（500 个、未归档 100 个）的报数。
  空间按作品和项目加起来先估一次，不够一样都不导。项目里生成的作品放回新项目的文件夹，不再另放进 AI 作品文件夹。
- 入参照敌意输入处理（I5、I8）：只认固定名字的「画布项目」文件夹，项目子文件夹必须是 UUID，文件路径照作品清单同一套规则校验，
  每个文件核对单链接普通文件和大小，工程文件过 `parseCanvasProjectWorkflow`，名字、标签过 `parseTransferredAiAssetMetadataItems`。
- 没有新增通道：`data-transfer:inspect-works` / `data-transfer:export` / `data-transfer:import` / `data-transfer:import-works` 的返回值各多一项可选的画布项目数，
  路径照旧只留在主进程（一次性 token）。旧版本读到新文件里的画布项目数照旧导对话、设置和作品；新版本读旧文件当没有项目。
- 设置页询问框有画布项目时标题换成「是否同时导出作品和画布项目？」，导出、导入完那句话报画布项目几个（新字 yoyo 确认，见第三轮复查第 6 条）。
