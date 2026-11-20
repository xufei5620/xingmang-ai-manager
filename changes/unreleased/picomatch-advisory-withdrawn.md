## 开发

- 构建依赖审计里 picomatch（GHSA-fc5q-39xc-vjpf）的临时放行删掉（原定北京 12-15 到期）。GitHub 11-18 撤回了这条公告，
  picomatch 维护者在 micromatch/picomatch#235 说不收不可信的 glob 规则就不是漏洞，npm audit 从此不再报它；
  picomatch 没发新版，树里还是 4.0.5，依赖不动。放行表现在是空的，npm audit 报出任何一条公告都会让审计变红。
