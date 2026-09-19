# 在 GitHub 上出包

这份文档回答一个问题：**怎么不碰自己的电脑，就拿到一份能装上试的星芒安装包。**

分两部分：第 1~3 节是现在就能用的「出测试包」，第 4 节是「把整条发版也搬到 GitHub」的方案，还没拍板、也还没实现。

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
| macOS | 两个 `.dmg`（arm64 / x64）、两个 `.zip`、`latest-mac.yml`、`SHA256SUMS` | 打开对应架构的 dmg，把 App 拖进「应用程序」，**第一次要右键点图标选「打开」**，直接双击会被拦 |

`.blockmap` / `latest.yml` / `latest-mac.yml` 是给自动更新用的，本地安装用不到，留着是为了这份产物和正式发布的产物形状完全一致。

---

## 2. 这两份包不能做什么

两条都是结构性的，不是这次忘了配：

**① 都不带私有加速线路。** 装上去以后「游戏加速」一页是空的。加速资源是 Mihomo 内核加私有节点配置，现在仓库里还没有，runner 上也就没有。**这一条是暂时的**：产品所有者 2026-09-19 已决定把三份资源直接提交进本仓库，资源落地后出包工作流会带上它们，见第 4 节。在那之前要验加速，只能在自己的电脑上出包。

**② macOS 那一份是用 runner 现场生成的一次性身份签的名**，不是钥匙串里那张发布证书。装和用没有区别（两者都没公证，都得右键打开），但 electron-updater 认签名身份，所以：

- 这份包**不能**从正式发布版自动更新过去，正式发布版也**不能**更新到这份包；
- 它**绝对不能**发给客户，artifact 的名字里就写着 `DO-NOT-PUBLISH`。

Windows 那一份除了没有加速线路，与正式发布的产物走的是同一条门禁（`release:build:unsigned`），所以它适合用来验安装、启动、登录、装 CLI、界面这些。

---

## 3. 跑之前会撞上的一件事：版本号

`package-for-testing` 的 Windows 作业第一步就是发布前置检查，它会拒绝两种情况：

- `release-notes.md` 的第一行和 `package.json` 的版本对不上（现在第一行还是「未发布」）；
- 更新源上已经有一个不低于本地的版本。

也就是说，**要出 0.2.7 的包，得先把变更日志汇总掉、版本号改成 0.2.7**：

```bash
npm run changelog:collect     # 把 changes/unreleased/ 的分片汇入两份日志并删掉分片
# 然后把 CHANGELOG.md 的「## Unreleased」和 release-notes.md 的「未发布」改成 0.2.7
# 再把 package.json 的 version 改成 0.2.7
```

这一步可以由一个 PR 做掉，合进 main 之后再点 Run workflow。macOS 那一份不看这个，什么时候点都能出。

---

## 4. 让云端出的包带上私有加速线路

**这一条已经拍板**（产品所有者，2026-09-19）：三份加速资源直接提交进本仓库。仓库是公开的，风险已当面说明并由产品所有者接受——节点地址和密码等同于公开，一旦被薅就得换节点。下面是资源该怎么放。

### 4.1 三份资源目录的位置和格式

资源仍然在本机用 `scripts/stage-acceleration-bundle.cjs` 生成，云端不重新生成。生成出来的三个目录整个放进仓库：

```
acceleration-bundles/
  win32-x64/      # --platform 省略（默认 win32），manifest.json 的 version 是 1，内核叫 mihomo.exe
  darwin-arm64/   # --platform darwin --arch arm64，version 2，内核叫 mihomo
  darwin-x64/     # --platform darwin --arch x64，version 2，内核叫 mihomo
```

每个目录里必须**恰好**是这五个文件，多一个少一个都会被 `resolveAccelerationBundleResources` 拒掉：

`manifest.json`、内核（`mihomo.exe` 或 `mihomo`）、`profile.yaml`、`LICENSE-mihomo.txt`、`THIRD-PARTY-NOTICES.txt`

`manifest.json` 里的 `coreSha256` / `profileSha256` 必须与同目录的文件对得上，`platform` / `arch` 必须与目录名一致。这些都是生成脚本自己写进去的，只要不手工改就不会错。

**目录名不要用 `release-` 开头**：`.gitignore` 里有 `release-*/`，那样提交不上去。

### 4.2 出包时资源怎么进到构建里

构建入口要求加速资源目录**位于项目目录之外**，这道检查不会为了这件事放松——它防的是仓库里一个残留目录让某次构建悄悄带上线路。工作流的做法是先把 `acceleration-bundles/<目标>` 复制到 runner 的临时目录，再把临时目录显式传给构建：Windows 侧是 `XINGMANG_ACCELERATION_BUNDLE_DIR`，macOS 侧是 `--acceleration-arm64` / `--acceleration-x64` 两个参数。

**这部分还没实现**，要等资源真的进了仓库再做：没有真实资源，清单校验过不去，写出来的也是没验证过的代码。资源合并之后会有一个单独的 PR 接上，同时解决一个已知冲突——`--ci-temporary-signing` 与两个加速参数目前是互斥的，而 macOS 测试包正是靠前者签名的。

### 4.3 仓库体积

三个 Mihomo 内核各十几 MB，一次提交约几十 MB，进 git 历史后删不掉。单个文件没到 GitHub 100 MB 的硬上限，**不需要 Git LFS**。但每换一次内核版本就再压一份同样大小进历史，所以内核升级不要频繁提交。

### 4.4 让 macOS 包用真正的发布签名

需要把钥匙串里那张自签证书**连私钥**导成 `.p12`，base64 之后存成 `release` 环境的 secret，再加一个密码 secret 和一个证书 SHA-256 指纹 secret。工作流里建临时钥匙串导入，构建完删掉。

代价同样要想清楚：那张证书的私钥一旦泄露，别人就能签出一个客户端会当成「同一发布者」的更新包。**只做安装测试的话不需要这一项**，第 1 节的包已经够用。

---

## 5. 方案（待拍板）：把整条发版搬到 GitHub

目标是把现在要在自己电脑上做的这几步搬上去：汇总变更日志、改版本号、出包、传 R2、打 tag、发 GitHub Release。**装到真机上点一遍验收这一步搬不走**，还是得自己做。

### 5.1 拆成三段

**第一段：版本收口（PR）**
一个 PR 做完 `npm run changelog:collect`、两份日志的标题改成版本号、`package.json` 改版本号。`release-notes.md` 首行必须等于 `package.json` 版本，这条已经有门禁。合进 main 就是「这一版定了」。

**第二段：出正式包（workflow_dispatch，跑在 `release` 环境）**
输入一个 `confirm_version`，与 `package.json` 不一致就拒（release-build.yml 已有这段，照抄）。跑完整发布门禁出 Windows 和 macOS 两份包，带上第 4 节的加速线路和 4.4 的 macOS 签名。产物只上传 Actions artifact，**不传任何地方**。

**第三段：发布（workflow_dispatch，跑在 `release` 环境，要人工审批）**
拿第二段的产物，按 `docs/RELEASING.md` 的顺序传 R2：**先安装包和 blockmap，最后才覆盖 `latest.yml` / `latest-mac.yml`**；反了的话用户会在文件还没传完时就被告知有新版本。传完打 tag、建 GitHub Release。

三段分开而不是一条龙，是因为第三段之前必须插进「在真机上装一遍」这个人工环节。

### 5.2 要准备的 secret

全部放进仓库 Settings 的 **Environments → release**（不要放仓库级：`workflow_dispatch` 可以指定任意分支，仓库级 secret 对任意分支可见）。`release` 环境还要配上 required reviewers，并把 deployment branches 限制为 `main`。

| Secret | 是什么 | 用在哪一段 |
|---|---|---|
| `MAC_SIGNING_P12_BASE64` | 发布签名证书（含私钥）导出的 .p12，base64 | 第二段 |
| `MAC_SIGNING_P12_PASSWORD` | 上面那个 .p12 的密码 | 第二段 |
| `MAC_SIGNING_SHA256` | 该证书的 SHA-256 指纹（不是机密，但要和上面成套） | 第二段 |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | R2 凭据，**权限只给 `xingmang-manager/` 前缀的写入**，不要给整桶、不要给删除 | 第三段 |
| `R2_ACCOUNT_ID` / `R2_BUCKET` | R2 桶的定位信息 | 第三段 |

### 5.3 还没决定的地方

- 第三段要不要顺手发 GitHub Release（Release 的附件是公开可下载的；线路资源本身已经决定公开进仓库，这一点不再构成阻碍）。
- tag 只在第三段成功之后打，还是第一段合并时就打。
- 历史版本的 tag 要不要补。

先按这三段实现，还是把第二段和第三段合成一个带审批的工作流，等拍板。
