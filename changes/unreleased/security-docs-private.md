## 开发

- 公开仓库收起「哪里还有洞」的材料（安全清单安-2、安-5）：`docs/audits/` 三轮审计（2026-10-28、10-29、11-18）原样搬到
  云端项目的共享文件夹，仓库里删掉；引用它的 6 处（三个 R29 分片、`scripts/renderer-single-copy.mjs`、`e2e/harness.test.mjs`
  的注释、`CHANGELOG.md` 0.2.23 段一行）改成只写编号。`docs/COLLABORATION.md` §2 记下以后审查报告不进本仓。
- 界面原型里的演示账号换成假的：名字「李华」、邮箱都用 `example.com` / `example.net`、示例密码 `demo-pass-1` / `demo-pass-2`
  （`ui-spec/v4/` 原型、`ui-spec/work/` 源码和由它重建的 v3.1.1 原型）。只改设计稿里的演示数据，产品界面一个字没动。
