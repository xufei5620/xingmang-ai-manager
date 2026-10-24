## 用户

- Windows 上把新应用存到了 D 盘等别的盘的电脑，Claude Desktop 检测不通过时，首页和安装出错框会说清原因，并教你怎么移回 C 盘。

## 开发

- Claude Desktop 装在非系统盘应用卷（`<盘符>:\WindowsApps`，`C:\Program Files\WindowsApps\<包>` 是系统放的链接）时，
  `verifyExternalClientPath` 照旧拒绝（yoyo 2026-10-24 定：校验不放宽）。只在核对已经不过之后，`appx-volume-link.ts`
  认出这个链接，`external-client-runtime.ts` 把「客户端 AppX 路径身份无法验证」换成教客户移回系统盘的话；
  安装时这句不再套「无法确认当前安装状态：」。
