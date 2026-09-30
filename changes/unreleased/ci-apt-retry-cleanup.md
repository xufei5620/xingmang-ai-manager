## 开发

- CI：linux-test 装 Chromium 系统库改由 `scripts/ci-install-chromium-deps.sh` 执行。第一次尝试超时后，先以 root 清掉 sudo 起的、timeout 杀不到的 apt/dpkg 残留，等 dpkg 锁放开再重试；首次限时从 4 分钟放宽到 6 分钟。#695 两次尝试都白费就是因为第一次的 apt-get 活了下来、攥着锁。
