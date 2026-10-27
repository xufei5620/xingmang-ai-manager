## 用户

- 新增 Linux 版（Ubuntu、Debian），装法见安装教程。

## 开发

- deb 的 `Maintainer` 从只写公司名改成 Debian 要求的「名字 <邮箱>」：`绍兴星芒文化传媒有限责任公司 <xufei5620136@gmail.com>`
  （`electron-builder.config.cjs` 的 `linux.maintainer`，yoyo 10-27 给的邮箱；会印在每个安装包里，软件中心详情、
  `apt show` / `dpkg -s` 看得到）。`Vendor` 照旧只写公司名，`Homepage` 不动。
  `scripts/linux-build-config.test.cjs` 钉住这个格式。Linux 对外首发仍由仓库变量 `XINGMANG_PUBLISH_LINUX` 决定，本条不碰开关。
