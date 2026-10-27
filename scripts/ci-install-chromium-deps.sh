#!/bin/bash
# linux-test 用：apt 装 Chromium 的系统库（含渲染层测试排版要用的中日文字体），
# 每次尝试限时，超时后把 apt 残留进程清干净、等 dpkg 锁放开再重试。
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
# 2026-10-26（#1431 run 40407332094 两次，#1426、#1442、#1447、#1423 各一次）：
# 索引一秒下完，包却只有 40 多 KB/s，要下的 25.9 MB 在两次限时里下不完，一条测试
# 没跑就红；同一时刻别的 runner 12 秒装完。慢的是 Azure 镜像，不是 apt 卡住，再加
# 时限也只是赌运气，所以要下的包由工作流用 actions/cache 存起来：给了
# CI_APT_DEB_CACHE_DIR，装之前把里面的 .deb 放进 apt 的下载目录，装好后把这次
# 装上的那些版本拷回去给工作流存。下载目录里已有的 .deb，apt 只看大小对不对就拿去
# 以 root 装（沙箱里实测：换成同样大小的一串零，apt 不重下，直接交给 dpkg），所以放进去之前
# 先拿本机签过名的索引核对每个文件的 SHA256，核不上的（包括比这台机器索引还新的
# 版本）不放，留给 apt 自己下、自己核。每次尝试前都放一遍：前一次跑过
# `apt-get update`，索引新了，能放进去的就多了。缓存没命中时还是要下，所以多给
# 一次尝试，每次都接着前一次下完的包往下下。
#
# 下面几个环境变量只给 scripts/ci-install-chromium-deps.test.cjs 用假 apt 演练。
set -uo pipefail
shopt -s nullglob

read -r -a attempt_limits <<< "${CI_APT_ATTEMPT_SECONDS:-360 240 180}"
lock_wait_seconds="${CI_APT_LOCK_WAIT_SECONDS:-60}"
read -r -a sudo_prefix <<< "${CI_APT_SUDO-sudo}"
read -r -a process_names <<< "${CI_APT_PROCESS_NAMES:-apt-get apt dpkg}"
read -r -a lock_files <<< "${CI_APT_LOCK_FILES:-/var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/cache/apt/archives/lock /var/lib/apt/lists/lock}"
read -r -a install_command <<< "${CI_APT_INSTALL_COMMAND:-npx --no-install playwright install-deps chromium}"
read -r -a repair_command <<< "${CI_APT_REPAIR_COMMAND-dpkg --configure -a}"
deb_cache_dir="${CI_APT_DEB_CACHE_DIR:-}"
archives_dir="${CI_APT_ARCHIVES_DIR:-/var/cache/apt/archives}"
read -r -a installed_command <<< "${CI_APT_INSTALLED_COMMAND:-}"
read -r -a index_command <<< "${CI_APT_INDEX_COMMAND:-apt-cache}"

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

# 本机索引里这几个包的每个版本，一行一个：apt 下载目录里它该叫的文件名、SHA256。
# 一次查完：apt-cache 每起一次都要把索引读一遍，在 runner 上一秒上下。
function index_hashes() {
  "${index_command[@]}" show "$@" 2> /dev/null | awk '
    function emit() {
      if (p != "" && v != "" && a != "" && sha != "") { gsub(/:/, "%3a", v); print p "_" v "_" a ".deb " sha }
      p = v = a = sha = ""
    }
    /^Package: / { p = $2 }
    /^Version: / { v = $2 }
    /^Architecture: / { a = $2 }
    /^SHA256: / { sha = $2 }
    /^$/ { emit() }
    END { emit() }'
}

function seed_cached_debs() {
  [[ -n "$deb_cache_dir" ]] || return 0
  local debs=("$deb_cache_dir"/*.deb)
  if (( ${#debs[@]} == 0 )); then
    echo "No cached .deb files to start from, apt downloads every package"
    return 0
  fi

  local deb name packages=() index expected trusted=()
  for deb in "${debs[@]}"; do
    name="${deb##*/}"
    packages+=("${name%%_*}")
  done
  index="$(index_hashes "${packages[@]}")"
  for deb in "${debs[@]}"; do
    expected="$(awk -v name="${deb##*/}" '$1 == name { print $2; exit }' <<< "$index")"
    if [[ -n "$expected" && "$(sha256sum < "$deb")" == "$expected "* ]]; then
      trusted+=("$deb")
    fi
  done
  if (( ${#trusted[@]} > 0 )); then
    as_root cp -- "${trusted[@]}" "$archives_dir"/ || return 1
  fi
  echo "Seeded apt's download folder with ${#trusted[@]} of ${#debs[@]} cached .deb files"
  if (( ${#trusted[@]} < ${#debs[@]} )); then
    echo "The other $(( ${#debs[@]} - ${#trusted[@]} )) did not match this runner's package index, apt downloads those itself"
  fi
}

# apt 存包的文件名是「包名_版本_架构.deb」，版本里的冒号写成 %3a。
function installed_deb_names() {
  if (( ${#installed_command[@]} > 0 )); then
    "${installed_command[@]}"
  else
    dpkg-query -W -f='${Package}_${Version}_${Architecture}.deb\n'
  fi | sed 's/:/%3a/g'
}

# 只留这次装上的版本：缓存是从上一份接着存的，不筛的话被安全更新换掉的旧版本
# 会一份份攒下去。
function keep_installed_debs() {
  [[ -n "$deb_cache_dir" ]] || return 0
  local installed
  installed="$(installed_deb_names)" || return 1
  mkdir -p "$deb_cache_dir" || return 1
  rm -f -- "$deb_cache_dir"/*.deb

  local deb kept=0 bytes=0
  for deb in "$archives_dir"/*.deb; do
    grep -qxF -- "${deb##*/}" <<< "$installed" || continue
    cp -- "$deb" "$deb_cache_dir"/ || return 1
    kept=$(( kept + 1 ))
    bytes=$(( bytes + $(stat -c %s "$deb") ))
  done
  echo "Kept $kept .deb files ($(( bytes / 1024 )) KiB) for the apt download cache"
  # 一个也没有就不让工作流存：存下一份空的，以后每次都算命中、却每次都要全下。
  if (( kept > 0 )) && [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    echo "cache-ready=true" >> "$GITHUB_OUTPUT"
  fi
}

attempt=0
for limit in "${attempt_limits[@]}"; do
  attempt=$(( attempt + 1 ))
  seed_cached_debs || echo "::warning::could not seed apt's download folder from the cache, apt downloads every package"
  if timeout --kill-after=20s "${limit}s" "${install_command[@]}"; then
    keep_installed_debs || echo "::warning::could not keep the downloaded .deb files for the apt download cache"
    exit 0
  fi
  echo "::warning::Chromium system library install attempt $attempt failed or ran past ${limit}s"
  # 最后一次失败后不再收拾：后面没有 apt 要跑，这一步直接报错。
  (( attempt < ${#attempt_limits[@]} )) || break
  clear_leftover_apt || break
done

echo "::error::apt could not install Chromium's system libraries after $attempt bounded attempts"
exit 1
