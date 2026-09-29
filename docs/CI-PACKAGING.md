# 在 GitHub 上出包

这份文档回答一个问题：**怎么不碰自己的电脑，就拿到一份能装上试的星芒安装包。**

分两部分：第 1~4 节是「出测试包」，第 5 节是「出正式包并发布」。

---

## 1. 点一下就出包

1. 打开仓库的 **Actions** 页面。
2. 左边一列工作流里选 **package-for-testing**。
3. 右上角点 **Run workflow**，会弹出一个小面板：
   - **Use workflow from**：选 `main`（除非你想试某个分支上的改动）。
   - **要出哪些平台的包**：`both` 出两个，也可以只出 `windows` 或 `macos`。
4. 点绿色的 **Run workflow**。页面上会多出一行正在跑的记录，点进去能看到每一步。
5. Windows 那一份大约要一小时（它把类型检查、四套测试、编译、三个冒烟和产物校验全跑一遍），macOS 那一份大约半小时。跑完之后，回到这次运行的页面，**拉到最下面的 Artifacts**，点名字就下载。

下载下来是个 zip，解开以后：

| 平台 | 里面是什么 | 怎么装 |
|---|---|---|
| Windows | `星芒AI管理工具 Setup <版本>.exe`，外加 `.blockmap` 和 `latest.yml` | 双击 exe。会弹「未知发布者」，这是预期的，0.2.7 本来就没有代码签名证书 |
| macOS | 两个 `.dmg`（`Apple-Silicon-arm64` / `Intel-x64`）、两个 `.zip`、`latest-mac.yml`、`SHA256SUMS` | 按自己的芯片打开对应的 dmg（「关于本机」里写 Apple M 系列就选 Apple-Silicon，写 Intel 就选 Intel），把 App 拖进「应用程序」，**第一次先双击一次（提示框点「完成」），再去「系统设置 → 隐私与安全性」点「仍要打开」并输密码**；macOS 15 起右键「打开」已经放不了行 |

`.blockmap` / `latest.yml` / `latest-mac.yml` 是给自动更新用的，本地安装用不到，留着是为了这份产物和正式发布的产物形状完全一致。

---

## 2. 这两份包不能做什么

**两份都带私有加速线路**，「游戏加速」那一页与你自己电脑上出的包是同一回事，怎么做到的见第 4 节。剩下一条限制是结构性的：

**macOS 那一份是用 runner 现场生成的一次性身份签的名**，不是钥匙串里那张发布证书。装和用没有区别（两者都没公证，都得右键打开），但 electron-updater 认签名身份，所以：

- 这份包**不能**从正式发布版自动更新过去，正式发布版也**不能**更新到这份包；
- 它**绝对不能**发给客户，artifact 的名字里就写着 `DO-NOT-PUBLISH`。

Windows 那一份与正式发布的产物走的是同一条门禁（`release:build:unsigned`），资源也一样，跟发布版只差一个发布动作。验安装、启动、登录、装 CLI、加速、界面都算数。

---

## 3. 跑之前会撞上的一件事：版本号

`package-for-testing` 的 Windows 作业第一步就是发布前置检查，它会拒绝两种情况：

- `release-notes.md` 的第一行和 `package.json` 的版本对不上；
- 更新源上已经有一个不低于本地的版本。

也就是说，**每出一版新的包之前，得先把变更日志汇总掉、版本号改成要发的那一版**：

```bash
npm run changelog:collect     # 把 changes/unreleased/ 的分片汇入两份日志并删掉分片
# 然后把 CHANGELOG.md 的「## Unreleased」和 release-notes.md 的「未发布」改成新版本号
# 再把 package.json 的 version 改成同一个版本号
```

这一步由一个 PR 做掉，合进 main 之后再点 Run workflow（0.2.7 的这一步已经做完）。macOS 那一份不看这个，什么时候点都能出。

---

## 4. 云端出的包是怎么带上私有加速线路的

产品所有者 2026-09-19 拍板：共享线路直接进本仓库。仓库是公开的，风险已当面说明并由他接受——节点地址和密码等同于公开，一旦被薅就得换节点。

实际落地时拆成了两半，因为这两样东西的性质不同：

**节点在仓库里。** `bundled-acceleration/profile.yaml` 是那 12 条共享线路，`bundled-acceleration/profile.sha256` 钉住它的字节。它只有几 KB，而且它就是那个"私有"的部分，必须随源码走才能让任何一台机器出的包都一样。

**内核不在仓库里。** Mihomo 内核是 MetaCubeX 的公开发布产物，三个平台各十几 MB；进不进仓库都不影响谁能拿到它，而进了 git 历史就永远删不掉，每升一次版再压一份进去。所以仓库里只有 `bundled-acceleration/cores.json` 这张对账表，工作流现场从上游取。

### 4.1 对账表和那三道哈希

`cores.json` 钉住内核版本，以及每个目标的：

- `assetSha256` —— 上游那个 release 资产整体的哈希；
- `coreSha256` —— 从资产里解出来的内核的哈希，**与发布者本机核对过的那一个、以及已发布安装包 manifest 里记的那一个是同一个值**；
- 顶上还有一个 `license.sha256`，钉住同一个 tag 下的 GPL v3 正文。

`scripts/prepare-acceleration-bundle.cjs` 把这三道逐一对完，任何一道不对就直接失败，不会"先用着"。下载只允许 GitHub 自己的几个域名、只允许 https，重定向每跳都重新校验一次来源（I10）。也就是说，runner 上那份内核与发布机上那份是同一份字节，这件事是可验证的，不是靠信任网络。

### 4.2 资源目录怎么生成、怎么进到构建里

工作流每个目标跑一次：

```bash
node scripts/prepare-acceleration-bundle.cjs --target darwin-arm64 --output "$RUNNER_TEMP/acceleration-darwin-arm64"
```

目标只有三个：`win32-x64`、`darwin-arm64`、`darwin-x64`。脚本下载并对账之后，仍然调 `scripts/stage-acceleration-bundle.cjs` 生成真正的五文件资源目录（`manifest.json`、内核、`profile.yaml`、`LICENSE-mihomo.txt`、`THIRD-PARTY-NOTICES.txt`）——那套节点字段白名单和原子写入只有一份实现，这里不另抄一份。

**输出目录必须在项目目录之外**，这道检查没有为了 CI 放松：它防的是仓库里一个残留目录让某次构建悄悄带上线路。工作流用的是 runner 的临时目录，再显式传给构建：Windows 侧是 `XINGMANG_ACCELERATION_BUNDLE_DIR`，macOS 侧是 `--acceleration-arm64` / `--acceleration-x64` 两个参数。

脚本用到主进程里那套安全读写和内核校验，所以两个作业都在它之前编译一次主进程。

### 4.3 换一个内核版本要改什么

只改 `cores.json`：版本号、三个 `asset`、三对 `assetSha256` / `coreSha256`、以及 `license.sha256`。哈希要在自己电脑上核对过再填——**这张表就是这条链路的信任根**，它进仓库、过审查，下载回来的字节才有东西可比。改完 `npm run test:scripts` 会校验表的格式，但对不对得上真实上游只有跑一次工作流才知道。

### 4.4 `--ci-temporary-signing` 与线路参数

2026-09-19 之前这两者是互斥的，理由是 CI 上根本没有线路资源。现在能现场准备了，前提不再成立，限制已经去掉：签名身份是不是一次性的，与带不带线路本来就是两件事。

### 4.5 让 macOS 包用真正的发布签名

需要把钥匙串里那张自签证书**连私钥**导成 `.p12`，base64 之后存成 `release` 环境的 secret，再加一个密码 secret 和一个证书 SHA-256 指纹 secret。工作流里建临时钥匙串导入，构建完删掉。

代价同样要想清楚：那张证书的私钥一旦泄露，别人就能签出一个客户端会当成「同一发布者」的更新包。**只做安装测试的话不需要这一项**，第 1 节的包已经够用。

---

## 5. 把整条发版搬到 GitHub

2026-09-20 已落地为 `.github/workflows/publish-release.yml`。它把过去要在自己电脑上做的这几步搬上去：出包、传 R2、打 tag、发 GitHub Release。**装到真机上点一遍验收这一步搬不走**，还是得自己做——工作流特意在那里停下来等你。

版本收口仍然是一个单独的 PR：`npm run changelog:collect`、两份日志的标题改成版本号、`package.json` 改版本号（`release-notes.md` 首行必须等于 `package.json` 版本，这条已经有门禁）。合进 main 就是「这一版定了」，然后才点 Run workflow。

### 5.1 一次发布，两次批准

工作流分三个作业：

1. **windows-build** —— 走 `release:build:unsigned` 的完整发布门禁，带第 4 节的加速线路。不读任何 secret。
2. **macos-build** —— 用**已发布的那张签名证书**出双架构包，带加速线路，出完立刻把包启动一遍。它要读 `.p12`，所以挂 `environment: release`，会停下来等第一次 Approve。
3. **publish** —— 传 R2、打 tag、建 Release。同样挂 `environment: release`，等第二次 Approve。

第一次批准放行的只是「用真证书出一份包」，产物只躺在 Actions artifact 里，对外什么都没发生。把包下下来装机验收，过了再批第二次。

macOS 这一半与第 1 节那条测试路径的区别就在这张证书：测试包用 runner 现场生成的一次性身份，**绝不能**进更新源；正式包必须沿用已发布的那张，换一张等于让所有已装的 Mac 客户静默失去自动更新（原理见 `docs/RELEASING.md` 的 2.2）。签名预检会拿证书指纹跟 `scripts/macos-published-signing-identity.cjs` 里登记的台账对账，对不上直接失败。

上传顺序固定为**先安装包和 blockmap → 逐字节复核能从客户会用的地址下载下来 → 最后才覆盖 `latest.yml` / `latest-mac.yml`**；反了的话用户会在文件还没传完时就被告知有新版本。`scripts/publish-workflow-config.test.cjs` 把这个顺序钉住了。

### 5.2 要准备的 secret

全部放进仓库 Settings 的 **Environments → release**（不要放仓库级：`workflow_dispatch` 可以指定任意分支，仓库级 secret 对任意分支可见）。`release` 环境还要配上 required reviewers，并把 deployment branches 限制为 `main`——那两次批准就是靠它实现的，环境不存在时 GitHub 会自动建一个**没有任何保护规则**的同名环境。

| Secret | 是什么 | 用在哪个作业 |
|---|---|---|
| `CSC_NAME` | 签名身份名，即证书的 Common Name | macos-build |
| `XINGMANG_MAC_SIGNING_P12_BASE64` | 发布签名证书（含私钥）导出的 .p12，base64 | macos-build |
| `XINGMANG_MAC_SIGNING_P12_PASSWORD` | 上面那个 .p12 的密码 | macos-build |
| `XINGMANG_MAC_SIGNING_SHA256` | 该证书的 SHA-256 指纹（不是机密，但要和上面成套） | macos-build |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | R2 凭据，**权限只给 `xingmang-manager/` 前缀的写入**，不要给整桶、不要给删除 | publish |
| `R2_ACCOUNT_ID` / `R2_BUCKET` | R2 桶的定位信息 | publish |

`.p12` 只能从钥匙串导出后用 GitHub 的 secret 输入框直接粘，不要经过聊天、工单或邮件。

### 5.3 还没决定的地方

- 历史版本的 tag 要不要补（候选 commit 表在 `docs/RELEASING.md` 第 5 节，要逐个核对过才能打）。
