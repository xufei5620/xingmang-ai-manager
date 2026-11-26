## 开发

- 新增客户端版本上报（`client-version-report.ts` / `client-version-reporter.ts`，yoyo 11-20 选「软件主动报给控制台」）：登录着的软件每天最多一次、同一天换账号或升版本再报一次，把站点、这个站的用户编号、版本、系统大类、芯片五样 POST 到 `https://console.solov.cc/api/public/client-versions`，给控制台（xingmang-console）的用户详情显示「客户端版本」。只认 2xx、不带 cookie、拒绝重定向、10 秒超时、读回包限 4KB、一天最多试三次；本机只存发过那份的摘要。跟匿名使用统计是两路（那一路仍不带账号），不受那个开关管；开发版、本机编的版本、CI 不报，`XINGMANG_DISABLE_CLIENT_VERSION_REPORT=1` 临时关。控制台的接收口先上线，这一版发出去后才有数据。
