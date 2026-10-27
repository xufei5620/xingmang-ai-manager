## 开发

- Codex 桌面端离线包同步（`sync-chatgpt-official-cos`）不再在 x64 先传上新版时删掉桶清单里的 ARM64 条目：两个 Windows 架构各带自己的包版本，没跟上的那个保留上一次核过的包和许可，等它自己的作业成功再换；生产者校验改成「任何一条都不能比 `windows.buildVersion` 新」。以前 ARM64 那次传不完（#1047 第 47、48 次）时 ARM 客户在桶里一份都没有，只能退回商店和官网（#1061 第 8 条）。
- 客户端读 `chatgpt/latest.json`（`electron/desktop-package-bucket.ts`）跟着改：Windows 条目的包版本不比 `windows.buildVersion` 新就认，不再要求两者相等。包的真假照旧靠固定桶地址和路径、清单里的大小和 SHA-256、下完核的包身份、发布者、微软签名和版本，这几道一条没动。0.2.21 及以前的客户端遇到落后一版的条目照旧不认、走原来的路，和改之前一样。
- 跟「先等包」（#1404）接上：x64 已换新版、ARM64 的官方包还是上一版时，ARM64 那条留在桶里，这次作业算等包、不再报 `package-version-behind`。所选作业全成功后的终验（`verify-chatgpt-cos-index.cjs`）照旧只查缺项，不把留在上一版的架构当没同步完，免得等包时白报警。
