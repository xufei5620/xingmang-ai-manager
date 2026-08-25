# 下载子站方案（dl.solov.cc）

> 日期：2026-08-25。产品拍板：邀请链到独立子域，只做「注册 → 成功后下载」。本文是可执行方案，不是现状描述；落地前以本文 + 当时服务器配置为准。自动化测试仍不得对生产 `xm.solov.cc` 发真实注册请求。

## 1. 已定决策

1. **独立子域** `https://dl.solov.cc`，不挂在 `xm.solov.cc` 根路径上。`xm` 继续只做账号中心与中转。
2. **子站只做一件事**：带邀请码注册，成功后给出安装包。不要登录、找回密码、个人中心、充值、「去登录」入口。
3. **邀请关系**走 new-api 现成字段：URL `?aff=6B4j` → 注册体 `aff_code`。码错或为空仍可注册，只是没有邀请人。对外分享的链接前缀后期统一成 `https://dl.solov.cc/sign-up?aff=`（见第 7 节），不要网页一套、软件一套。
4. **下载不鉴权**。登录 cookie 在 `xm.solov.cc`，`dl.solov.cc` 看不见；不为了门禁去改 cookie Domain 为 `.solov.cc`。
5. **给人点的安装包三个**：Windows x64 一个；macOS **两个**（Apple Silicon arm64 + Intel x64）。自动更新用的 `.zip` / `.blockmap` / `latest-mac.yml` 不放在下载页。
6. **第一期不上 OpenList**。两个平台三个文件，静态页 + nginx 直出即可。
7. **后期邀请链接前缀两边一起改**：new-api 控制台里的 `https://xm.solov.cc/sign-up?aff=…` 改成 `https://dl.solov.cc/sign-up?aff=…`；软件端个人中心同步改成同一条，不再复制 xm 链接。

## 2. 为什么这样拆

`xm.solov.cc` 现网（2026-08-25 源站 `fxg-0321` 核实）：宝塔 nginx，`location ^~ /` 整站反代 `127.0.0.1:3000`（`new-api` v1.0.0-rc.25），且只认 Cloudflare 回源。根路径不能再当文件站。

他们已经用更长前缀挂过旁路（`/grokvid/`、`/logo.png`）。同域 `/download/` 也能做，但下载漏斗和账号站绑在一起，后续改邀请海报、缓存、证书都更拧。独立子域边界更干净。

不要整站反代 new-api：会带出控制台、登录、`/v1`。不要让浏览器直连 `xm.solov.cc/api`：跨域，还要改 CORS。

## 3. 目标形态

```
https://dl.solov.cc/sign-up?aff=6B4j
        │
        ├─ 页：注册表单（用户名 / 密码 / 确认密码 / 邮箱 / 验证码 / 协议）
        ├─ GET  /api/status              → 本机 new-api（要不要邮箱验证码）
        ├─ GET  /api/verification?email= → 本机 new-api
        ├─ POST /api/user/register       → 本机 new-api（带 aff_code）
        └─ 成功：三个下载按钮（不跳转登录）
```

浏览器只打 `dl.solov.cc`。nginx 把上面 3 条精确路径转到 `127.0.0.1:3000`，`Host` 仍传 `xm.solov.cc`，new-api 才认正式站点。邀请在 `POST /register` 时写入 `InviterId`。

页面只有两个状态：

| 状态 | 内容 |
|---|---|
| 注册 | 表单。`aff` 从查询串读取，可不单独展示 |
| 成功 | Windows / macOS Apple Silicon / macOS Intel 三个下载。无其它入口 |

协议与隐私政策在本页弹窗打开，正文来自账号站当前条款的本地副本（`dl-landing/legal/`），不跳到 `xm.solov.cc`。邀请码输入框始终展示：带 `?aff=` 进来则预填、只读，并写入本机 cookie（`xingmang_aff`，180 天）；同一设备之后不带邀请参数打开，仍自动带上并锁定该码。从未用邀请链接来过则可填可不填。注册仅接受 QQ 邮箱（`@qq.com`）。

## 4. 目录与产物

源站磁盘（建议）：

```text
/www/wwwroot/dl.solov.cc/
  index.html
  app.js                 # 可选，逻辑不要散进 HTML 也行
  latest.json            # 页面读文件名与版本，避免写死
  files/latest/
    Xingmang-Setup-<ver>.exe
    Xingmang-<ver>-arm64.dmg
    Xingmang-<ver>-x64.dmg
```

`latest.json` 示例：

```json
{
  "version": "0.1.4",
  "win": "/files/latest/Xingmang-Setup-0.1.4.exe",
  "macArm64": "/files/latest/Xingmang-0.1.4-arm64.dmg",
  "macX64": "/files/latest/Xingmang-0.1.4-x64.dmg"
}
```

落地页源码已在本仓 `dl-landing/`（`index.html` / `styles.css` / `app.js` / `latest.json`）。本地预览：`node dl-landing/preview.mjs`，打开 `http://127.0.0.1:4173/sign-up?aff=6B4j`。预览服只 mock 注册三接口，不打生产。上线时 scp/rsync 到 `/www/wwwroot/dl.solov.cc/`，不要带 `preview.mjs`。不要在服务器上长期手改。

macOS 构建还会打出 arm64/x64 的 zip 与 blockmap，供 `latest-mac.yml` 自动更新。那些文件可以另放更新目录（现有 `updatesnew.shenfengwl.fun` 或以后的 `/files/update/`），**不要出现在注册成功页**。

## 5. nginx

宝塔新建站点 `dl.solov.cc`，SSL，**套与 `xm.solov.cc` 相同的 Cloudflare 回源限制**（非 CF 回 `444`）。规则放 `extension/dl.solov.cc/`，避免面板重写站点时被清掉。

```nginx
# 只反代注册需要的接口，禁止把整个 / 指到 new-api
location = /api/status {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host xm.solov.cc;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
}

location = /api/verification {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host xm.solov.cc;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
}

location = /api/user/register {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host xm.solov.cc;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
}

location ^~ /files/ {
    alias /www/wwwroot/dl.solov.cc/files/;
    add_header Content-Disposition "attachment";
    expires 1h;
}

location / {
    root /www/wwwroot/dl.solov.cc;
    try_files $uri $uri/ /index.html;
}
```

`/sign-up` 与 `/` 都落到同一页，由前端读 `aff`。

不要反代：`/api/user/self`、`/api/token/`、`/api/user/login`、`/v1/`。验收时这些路径必须是静态 404，不能打到 new-api。

## 6. 页面逻辑

1. 读 `URLSearchParams` 的 `aff`，trim 后若像完整邀请 URL，抽出 `aff=`（与软件端 `parseInviteShowCode` 同语义即可）。
2. `GET /api/status`：`email_verification === true` 时显示验证码行（生产当前为开）。
3. 「获取验证码」：`GET /api/verification?email=`，客户端 60s 冷却；服务端本身有限流。
4. 提交前本地校验：用户名 ≤20、密码 8–20、两次一致、邮箱形状、已勾选协议。与软件端 `validation.ts` 对齐，避免两套规则。
5. `POST /api/user/register` JSON：`username`、`password`、`email`、`verification_code`，有码才带 `aff_code`。成功只看 `{ success: true }`，无 session。
6. 进入成功态，三个 `<a>` 指向 `latest.json` 里的路径。失败用 new-api 返回文案（可复用软件端 `account-errors.ts` 的中文映射）。

不写：登录跳转、账号检测、下载前登录。

## 7. 落地顺序

1. Cloudflare：`dl.solov.cc` A 到源站 `38.147.105.28`，橙云。
2. 宝塔：新建静态站 + 证书 + CF 回源限制。
3. 写入第 5 节 `extension/` 配置并重载 nginx。
4. 本仓加 `dl-landing/`，同步到 `/www/wwwroot/dl.solov.cc/`。
5. 把三个安装包放进 `files/latest/`，更新 `latest.json`。
6. 子站漏斗验收通过后，再改对外邀请链接前缀（第 8 节）。不要先改链接再上子站。

运维 SSH 端口是 **5620**（不是 22），密钥用本机 `~/.ssh/solov_fleet_ed25519`。

## 8. 后期：邀请链接前缀统一到 dl

new-api 存的是用户自己的 **aff 码**（如 `6B4j`），完整链接是前缀 + `?aff=` 拼出来的。现在两处前缀都还指向账号站：

| 出处 | 现状 | 后期 |
|---|---|---|
| new-api 网页 / 控制台「邀请链接」 | `https://xm.solov.cc/sign-up?aff=6B4j` | `https://dl.solov.cc/sign-up?aff=6B4j` |
| 软件端个人中心 `buildAccountInviteLink` | `https://xm.solov.cc/register?aff=6B4j` | **同一条**：`https://dl.solov.cc/sign-up?aff=6B4j` |

`/register` 与 `/sign-up` 在 new-api 里等价（前者 302 到后者并保留查询串）。对外统一用 `/sign-up?aff=`，海报、网页、客户端复制出来的字面量一致。

**new-api 怎么改**

- 只改**邀请链接的展示前缀**（主机 `xm.solov.cc` → `dl.solov.cc`），路径保持 `/sign-up?aff=<code>`。
- **不要**把全局「站点地址 / ServerAddress」改成 `dl.solov.cc`。那是账号站、邮件重置、OAuth、控制台用的；改了会把整站入口拽到下载子站。
- 若控制台没有单独的邀请前缀项，就在 new-api 前端拼邀请 URL 的那一处写死 `https://dl.solov.cc/sign-up`，或加一项只服务邀请的配置。

**软件端同步改**

- `src/components/account/account-center.ts` 的 `inviteBaseUrl` 不要再拼 `accountBaseUrl + '/register'`（`accountBaseUrl` 必须继续是 `https://xm.solov.cc`，登录/余额/写 Key 走账号后端）。
- 改成固定对外前缀：`https://dl.solov.cc/sign-up?aff=`。同步改 `account-center.test.ts`。
- 注册弹窗的 `parseInviteAffCode` **继续兼容**旧链 `https://xm.solov.cc/sign-up?aff=`、`/register?aff=` 和裸码。用户粘贴历史海报仍能抽出 `aff_code`。
- 软件发版与 new-api 前缀切换尽量同一天，避免「网页已是 dl、客户端还在复制 xm」。

**旧链接**

- `https://xm.solov.cc/sign-up?aff=…` 可继续留在账号站自己注册，或 302 到 `https://dl.solov.cc/sign-up` 并保留查询串。
- 绑定邀请人的仍是 `aff` 码本身，换主机不影响已发出去的码。

## 9. 验收

- 无 `aff`：能注册；邀请人「已邀请」不增加。
- 真码：新用户出现在该邀请人名单里。
- 假码：仍能注册，无邀请人。
- 验证码邮件照常到达。
- 未注册也能直接打开 `/files/latest/...`。
- `dl.solov.cc/api/token/`、`/v1/models` 不得打到 new-api。
- 成功页能区分 Windows / Apple Silicon / Intel 三个包。
- 后期改前缀后：new-api 控制台与软件端个人中心复制出的邀请链接均为 `https://dl.solov.cc/sign-up?aff=<code>`；粘贴旧 xm 链接仍能注册并绑定邀请人。

## 10. 明确不做（第一期）

- 登录、会话、下载门禁
- OpenList / 历史版本浏览器
- 改 new-api 源码或 `xm.solov.cc` 的 `location ^~ /`
- 浏览器跨域直连 `xm.solov.cc`
- 把更新 zip 和 DMG 混在下载页上

## 11. 相关

- new-api 注册字段：`docs/RECON-new-api.md`
- 软件端邀请码解析与个人中心链接（现状仍拼 xm，后期按第 8 节改 dl）：`src/components/account/account-center.ts`
- 软件端注册弹窗：`src/components/account/RegisterDialog.tsx`
- macOS 双架构产物：`docs/MACOS_FREE_DISTRIBUTION.md`、`npm run build:mac`
