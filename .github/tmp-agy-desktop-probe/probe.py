# One-off probe (docs/COLLABORATION.md §3): what the Antigravity desktop app's own updater
# (electron-updater, generic provider) is told, and what the files it names look like. Reads
# feeds and archive listings only; nothing is extracted to disk or run. Delete after use.
import io
import plistlib
import re
import urllib.error
import urllib.request
import zipfile

FEED = 'https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/'


def get(url, limit=8192, method='GET', headers=None):
    request = urllib.request.Request(url, method=method, headers={'User-Agent': 'electron-builder', **(headers or {})})
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            body = response.read(limit) if method == 'GET' else b''
            return response.status, response.geturl(), dict(response.headers), body
    except urllib.error.HTTPError as error:
        return error.code, url, dict(error.headers or {}), error.read(limit)
    except Exception as error:  # noqa: BLE001
        return None, url, {}, repr(error).encode()


def show(label, url, limit=8192, method='GET', headers=None):
    status, final, response_headers, body = get(url, limit, method, headers)
    print(f'== {label}: {url}\n   status={status} final={final}')
    for key in ('Content-Type', 'Content-Length', 'Location', 'ETag', 'Last-Modified', 'Cache-Control', 'x-goog-hash', 'Accept-Ranges'):
        if key in response_headers:
            print(f'   {key}: {response_headers[key]}')
    if body:
        print('   body:\n' + body[:limit].decode('utf-8', 'replace'))
    return status, body


feeds = {}
for name in ('latest.yml', 'latest-arm64.yml', 'latest-mac.yml', 'latest-mac-arm64.yml', 'latest-linux.yml', 'latest-linux-arm64.yml', 'beta.yml', 'stable.yml'):
    status, body = show(name, FEED + name)
    if status == 200:
        feeds[name] = body.decode('utf-8', 'replace')
show('feed root', FEED, 2000)
show('feed without trailing slash', FEED.rstrip('/') + '/latest.yml?noCache=1')

urls = set()
for name, text in feeds.items():
    version = re.search(r'^version:\s*(\S+)', text, re.M)
    for match in re.findall(r'^\s*-?\s*(?:url|path):\s*(\S+)', text, re.M):
        url = match if match.startswith('http') else FEED + match
        urls.add(url)
for url in sorted(urls):
    show('HEAD listed file', url, method='HEAD')

# The Mac zip electron-updater installs from: list its top level and read Info.plist.
for url in sorted(u for u in urls if u.endswith('.zip')):
    status, _, _, body = get(url, 600 * 1024 * 1024)
    if status != 200:
        continue
    print(f'== zip {url} bytes={len(body)}')
    with zipfile.ZipFile(io.BytesIO(body)) as archive:
        names = archive.namelist()
        print('   entries', len(names))
        tops = sorted({n.split('/')[0] for n in names})
        print('   top level', tops)
        symlinks = [i.filename for i in archive.infolist() if (i.external_attr >> 16) & 0o170000 == 0o120000]
        print('   symlink entries', len(symlinks), symlinks[:5])
        plist_name = next((n for n in names if re.fullmatch(r'[^/]+\.app/Contents/Info\.plist', n)), None)
        if plist_name:
            info = plistlib.loads(archive.read(plist_name))
            for key in ('CFBundleIdentifier', 'CFBundleShortVersionString', 'CFBundleVersion', 'LSMinimumSystemVersion', 'CFBundleExecutable', 'LSArchitecturePriority'):
                print('  ', key, '=', info.get(key))
