import hashlib, json, os, sys, tarfile, tempfile, urllib.request
ORIGIN = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/'
for name in ['darwin_arm64', 'darwin_amd64']:
    manifest = json.loads(urllib.request.urlopen(ORIGIN + name + '.json', timeout=30).read(16384))
    print(name, manifest['version'], manifest['url'])
    assert manifest['url'].startswith('https://storage.googleapis.com/antigravity-public/antigravity-cli/')
    with tempfile.TemporaryDirectory() as folder:
        archive = os.path.join(folder, 'a.tar.gz')
        with urllib.request.urlopen(manifest['url'], timeout=120) as response, open(archive, 'wb') as out:
            print('  content-type', response.headers.get('content-type'), 'length', response.headers.get('content-length'))
            out.write(response.read())
        print('  sha512 ok', hashlib.sha512(open(archive, 'rb').read()).hexdigest() == manifest['sha512'])
        with open(archive, 'rb') as raw:
            import gzip
            data = gzip.decompress(raw.read())
        print('  decompressed bytes', len(data))
        offset = 0
        while offset + 512 <= len(data):
            header = data[offset:offset + 512]
            if header == b'\0' * 512:
                print('  zero block at', offset, 'remaining nonzero', any(data[offset:]))
                break
            raw_name = header[0:100].rstrip(b'\0')
            size = int(header[124:136].rstrip(b'\0 ').decode() or '0', 8)
            print('  entry', repr(header[156:157]), repr(raw_name), 'size', size, 'mode', header[100:108].rstrip(b'\0 '), 'magic', repr(header[257:265]), 'prefix', repr(header[345:500].rstrip(b'\0')))
            if header[156:157] in (b'x', b'g', b'L'):
                print('    data', repr(data[offset + 512: offset + 512 + min(size, 400)]))
            offset += 512 + ((size + 511) // 512) * 512
