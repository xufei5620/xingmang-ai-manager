## 开发

- 「创作」页换着开几条视频时，模型表（各分组和每个分组的模型）和价目表只在开第一条时读：模型表由 `CreatePage` 按账号建一份 `createVideoStudioCatalogCache()`（`video-studio/catalog-cache.ts`，10 分钟，每个分组都读到了才记）经 `options.catalog` 交给工作台；价目表 `useVideoStudioPriceList` 改成同一个桥共用一份（`prices.ts`，原来输入框和每个工作台各存各的）。之前开 6 次视频多读 12 次分组、6 轮分组模型、12 次价目表（创作页复查第 3 条）。「刷新模型」照旧重读并换掉记着的那份。
