# One-off probe (docs/COLLABORATION.md §3): where does the Antigravity desktop app learn its
# latest version? Reads product.json out of the official Linux archive without extracting or
# running anything, then asks the update endpoints it names. Delete after use.
import json
import re
import tarfile
import urllib.error
import urllib.request

ARCHIVE = 'https://storage.googleapis.com/antigravity-public/antigravity-hub/2.34.0-5887025308631040/linux-x64/Antigravity.tar.gz'


def get(url, limit=4096, method='GET'):
    request = urllib.request.Request(url, method=method, headers={'User-Agent': 'probe'})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            body = response.read(limit) if method == 'GET' else b''
            return response.status, response.geturl(), dict(response.headers), body
    except urllib.error.HTTPError as error:
        return error.code, url, dict(error.headers or {}), error.read(limit)
    except Exception as error:  # noqa: BLE001
        return None, url, {}, repr(error).encode()


def show(label, url, limit=4096, method='GET'):
    status, final, headers, body = get(url, limit, method)
    print(f'== {label}: {url}\n   status={status} final={final}')
    for key in ('Content-Type', 'Content-Length', 'Location', 'ETag', 'Last-Modified', 'x-goog-hash'):
        if key in headers:
            print(f'   {key}: {headers[key]}')
    if body:
        print('   body:', body[:limit].decode('utf-8', 'replace'))
    return status, body


path = '/tmp/antigravity-linux.tar.gz'
urllib.request.urlretrieve(ARCHIVE, path)
product = None
package = None
asar_member = None
import io
import os
import struct
print('archive bytes', os.path.getsize(path))
with tarfile.open(path, 'r:gz') as archive:
    members = archive.getmembers()
    print('members', len(members))
    for member in members[:30]:
        print('  ', member.type, member.size, member.name)
    for member in members:
        name = member.name
        if re.search(r'(product|package)\.json$|app-update\.ya?ml$|update.*\.(json|ya?ml)$|\.asar$', name) and 'node_modules' not in name:
            print('candidate', member.size, name)
        if not member.isfile():
            continue
        if name.endswith('product.json') and 'node_modules' not in name and product is None:
            product = json.load(archive.extractfile(member))
            print('product.json at', name)
        elif name.endswith('resources/app/package.json'):
            package = json.load(archive.extractfile(member))
            print('package.json at', name)
        elif re.search(r'app-update\.ya?ml$', name):
            print('--- app-update.yml ---')
            print(archive.extractfile(member).read(4000).decode('utf-8', 'replace'))
        elif name.endswith('resources/app.asar'):
            asar_member = member
    if asar_member is not None:
        data = archive.extractfile(asar_member).read()
        _, header_size, _, json_size = struct.unpack('<IIII', data[:16])
        header = json.loads(data[16:16 + json_size])
        base = 8 + header_size
        for wanted in ('package.json', 'product.json'):
            entry = header.get('files', {}).get(wanted)
            if entry and 'offset' in entry:
                start = base + int(entry['offset'])
                content = json.loads(data[start:start + entry['size']])
                print('asar', wanted, 'found')
                if wanted == 'package.json':
                    package = package or content
                else:
                    product = product or content
        print('asar top-level entries:', sorted(header.get('files', {}).keys())[:60])

if package:
    print('package version:', package.get('version'), 'name:', package.get('name'))
    print('package keys:', sorted(package.keys()))
    for key, value in package.items():
        if re.search(r'url|update|publish|build|repository|homepage|main', key, re.I):
            print('package', key, '=', json.dumps(value, ensure_ascii=False)[:1500])
if not product:
    print('no product.json')
    product = {}

interesting = {}
for key, value in product.items():
    if isinstance(value, (str, int, bool)) and (re.search(r'url|update|quality|commit|version|name|id|win32|darwin|download', key, re.I)):
        interesting[key] = value
print(json.dumps(interesting, indent=2, ensure_ascii=False)[:6000])
for key, value in product.items():
    if isinstance(value, str) and value.startswith('https://'):
        print('URL key', key, '=', value)

update_url = product.get('updateUrl')
quality = product.get('quality', 'stable')
commit = product.get('commit')
if update_url:
    for platform in ('win32-x64-user', 'win32-arm64-user', 'win32-x64', 'darwin-arm64', 'darwin', 'darwin-universal', 'linux-x64'):
        show(f'update {platform} from this commit', f'{update_url}/api/update/{platform}/{quality}/{commit}')
        show(f'update {platform} latest', f'{update_url}/api/update/{platform}/{quality}/latest')
    show('releases', f'{update_url}/api/releases/{quality}')

show('download page', 'https://antigravity.google/download', 2000)
body = get('https://antigravity.google/download', 2_000_000)[3]
text = body.decode('utf-8', 'replace')
for match in sorted(set(re.findall(r'https?://[^"\'\s<>]*(?:antigravity-hub|storage\.googleapis|run\.app|update)[^"\'\s<>]*', text))):
    print('page link:', match)
scripts = sorted(set(re.findall(r'<script[^>]+src="([^"]+)"', text)))
print('scripts:', scripts[:20])
for src in scripts[:12]:
    url = src if src.startswith('http') else 'https://antigravity.google' + (src if src.startswith('/') else '/' + src)
    _, _, _, js = get(url, 5_000_000)
    js_text = js.decode('utf-8', 'replace')
    for match in sorted(set(re.findall(r'https?://[^"\'\s<>`]*(?:antigravity-hub|storage\.googleapis|run\.app|update|latest)[^"\'\s<>`]*', js_text)))[:40]:
        print('script link:', src, match)
    for match in sorted(set(re.findall(r'antigravity-hub[^"\'\s<>`]{0,120}', js_text)))[:20]:
        print('script hub ref:', src, match)
