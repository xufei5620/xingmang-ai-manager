#!/bin/bash
# linux-test 用：apt 装 Chromium 的系统库（含渲染层测试排版要用的中日文字体），
# 每次尝试限时，超时后把 apt 残留进程清干净、等 dpkg 锁放开再重试一次。
#
# 为什么不是一行 `timeout 4m npx playwright install-deps`：
# - #653：apt 在镜像上一声不吭地卡住，没有外部时限就一直等到作业 30 分钟上限。
# - #695（run 36759893210）：timeout 杀掉了 npx，但 Playwright 经 sudo 起的 apt-get
#   在 sudo 自己的会话里，不在 timeout 能杀到的进程组里，于是活了下来、攥着
#   /var/lib/dpkg/lock-frontend；第二次尝试一秒内就撞锁失败，两次都白费。
#   那次 apt 其实在慢慢下（Azure 镜像上一个 7MB 字体包 80 秒），第一次给得太短。
# 所以第一次给足时间，超时后以 root 按名字清掉 apt/dpkg 及其下载进程，等所有
# 锁文件没人占用、`dpkg --configure -a` 收尾，再重试；已下完的 .deb 留在
# /var/cache/apt/archives，重试接着用，不从头下。
#
# 下面几个环境变量只给 scripts/ci-install-chromium-deps.test.cjs 用假 apt 演练。
set -uo pipefail

read -r -a attempt_limits <<< "${CI_APT_ATTEMPT_SECONDS:-360 240}"
lock_wait_seconds="${CI_APT_LOCK_WAIT_SECONDS:-60}"
read -r -a sudo_prefix <<< "${CI_APT_SUDO-sudo}"
read -r -a process_names <<< "${CI_APT_PROCESS_NAMES:-apt-get apt dpkg}"
read -r -a lock_files <<< "${CI_APT_LOCK_FILES:-/var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/cache/apt/archives/lock /var/lib/apt/lists/lock}"
read -r -a install_command <<< "${CI_APT_INSTALL_COMMAND:-npx --no-install playwright install-deps chromium}"
read -r -a repair_command <<< "${CI_APT_REPAIR_COMMAND-dpkg --configure -a}"

function as_root() {
  "${sudo_prefix[@]}" "$@"
}

function locks_held() {
  as_root fuser "${lock_files[@]}" > /dev/null 2>&1
}

function clear_leftover_apt() {
  for name in "${process_names[@]}"; do
    as_root pkill -KILL -x "$name" || true
  done
  # apt 的下载方法（http、https、store…）是 apt-get 的子进程，主进程死了它们
  # 也可能还挂在连接上。
  as_root pkill -KILL -f '^/usr/lib/apt/methods/' || true

  local waited=0
  while locks_held; do
    if (( waited >= lock_wait_seconds )); then
      echo "::warning::apt/dpkg locks still held after ${lock_wait_seconds}s"
      as_root fuser -v "${lock_files[@]}" || true
      return 1
    fi
    sleep 2
    waited=$(( waited + 2 ))
  done

  if (( ${#repair_command[@]} > 0 )); then
    as_root "${repair_command[@]}" || true
  fi
}

attempt=0
for limit in "${attempt_limits[@]}"; do
  attempt=$(( attempt + 1 ))
  if timeout --kill-after=20s "${limit}s" "${install_command[@]}"; then
    exit 0
  fi
  echo "::warning::Chromium system library install attempt $attempt failed or ran past ${limit}s"
  clear_leftover_apt || break
done

echo "::error::apt could not install Chromium's system libraries after $attempt bounded attempts"
exit 1
