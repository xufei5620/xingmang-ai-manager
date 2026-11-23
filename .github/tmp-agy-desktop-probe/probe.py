# One-off probe (docs/COLLABORATION.md §3): how the Antigravity desktop app asks for updates.
# Reads dist/*.js out of app.asar in the official Linux archive (as data, never run) and prints
# the code around its update requests, then tries the paths it builds. Delete after use.
import json
import re
import struct
import tarfile
import urllib.error
import urllib.request

ARCHIVE = 'https://storage.googleapis.com/antigravity-public/antigravity-hub/2.34.0-5887025308631040/linux-x64/Antigravity.tar.gz'
FEED = 'https://antigravity-hub-auto-updater-974169037036.us-central1.run.app'


def get(url, limit=8192):
    request = urllib.request.Request(url, headers={'User-Agent': 'probe'})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.status, dict(response.headers), response.read(limit)
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers or {}), error.read(limit)
    except Exception as error:  # noqa: BLE001
        return None, {}, repr(error).encode()


path = '/tmp/antigravity-linux.tar.gz'
urllib.request.urlretrieve(ARCHIVE, path)
with tarfile.open(path, 'r:gz') as archive:
    member = archive.getmember('Antigravity-x64/resources/app.asar')
    data = archive.extractfile(member).read()
_, header_size, _, json_size = struct.unpack('<IIII', data[:16])
header = json.loads(data[16:16 + json_size])
base = 8 + header_size


def walk(node, prefix=''):
    for name, entry in node.get('files', {}).items():
        full = f'{prefix}{name}'
        if 'files' in entry:
            if name != 'node_modules':
                yield from walk(entry, full + '/')
        else:
            yield full, entry


files = dict(walk(header))
print('dist files:', [name for name in files if name.startswith('dist/')][:80])
entry = files['dist/updater.js']
start = base + int(entry['offset'])
print('===== dist/updater.js')
print(data[start:start + entry['size']].decode('utf-8', 'replace'))

status, headers, body = get(FEED + '/releases', 20000)
print('releases', status, headers.get('Content-Type'), body[:20000].decode('utf-8', 'replace'))
for candidate in ('/manifest/latest-x64-win.yml', '/manifest/latest-x64-windows.yml', '/manifest/latest-arm64-mac.yml', '/manifest/latest-x64-linux.yml', '/manifest/windows_amd64.json', '/manifest/win32-x64.json', '/manifest/windows-x64.json', '/manifest/darwin_arm64.json',
                  '/manifest/darwin-arm64.json', '/manifest/linux_amd64.json', '/manifests/windows_amd64.json', '/manifest/latest.json', '/manifest/stable.json'):
    status, headers, body = get(FEED + candidate, 3000)
    print('try', candidate, status, headers.get('Content-Type'), body[:600].decode('utf-8', 'replace'))
