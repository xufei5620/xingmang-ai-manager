# One-off probe (docs/COLLABORATION.md §3): the other two desktop feeds, and what is inside the
# Mac zip the updater installs from (listing and Info.plist only; nothing extracted or run).
import io
import plistlib
import re
import urllib.error
import urllib.request
import zipfile

FEED = 'https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/'


def get(url, limit=8192):
    request = urllib.request.Request(url, headers={'User-Agent': 'probe'})
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            return response.status, dict(response.headers), response.read(limit)
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers or {}), error.read(limit)


for name in ('latest-arm64-win.yml', 'latest-x64-mac.yml', 'latest-arm64-mac.yml', 'latest-x64-win.yml', 'latest-arm64-linux.yml', 'latest-x86-win.yml', 'latest-universal-mac.yml'):
    status, headers, body = get(FEED + name)
    print('==', name, status, {k: headers.get(k) for k in ('Content-Type', 'Cache-Control', 'Content-Length')})
    print(body.decode('utf-8', 'replace'))

status, headers, body = get(FEED + 'latest-arm64-mac.yml')
url = re.search(r'url:\s*(\S+\.zip)', body.decode()).group(1)
status, headers, data = get(url, 600 * 1024 * 1024)
print('zip', status, len(data), headers.get('Content-Type'))
with zipfile.ZipFile(io.BytesIO(data)) as archive:
    infos = archive.infolist()
    print('entries', len(infos), 'top', sorted({i.filename.split('/')[0] for i in infos}))
    links = [i.filename for i in infos if (i.external_attr >> 16) & 0o170000 == 0o120000]
    print('symlinks', len(links), links[:6])
    print('first entries', [i.filename for i in infos[:8]])
    info = plistlib.loads(archive.read('Antigravity.app/Contents/Info.plist'))
    for key in ('CFBundleIdentifier', 'CFBundleShortVersionString', 'CFBundleVersion', 'LSMinimumSystemVersion', 'CFBundleExecutable', 'CFBundleName'):
        print('  ', key, '=', info.get(key))
    executables = [i.filename for i in infos if i.filename.startswith('Antigravity.app/Contents/MacOS/')]
    print('MacOS dir', executables)
    servers = [i.filename for i in infos if 'language_server' in i.filename][:5]
    print('language_server entries', servers)
