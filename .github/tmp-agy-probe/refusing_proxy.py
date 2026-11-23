# 临时：模拟连不上谷歌的网络，记下 Antigravity CLI 想连哪些主机，核完就删。
# Every proxied request is logged and refused with 403, so the CLI behaves as if
# no Google host is reachable (loopback traffic bypasses proxies in Go).
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1])
LOG = sys.argv[2]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def refuse(self):
        with open(LOG, 'a', encoding='utf-8') as handle:
            handle.write(json.dumps({'t': round(time.time(), 3), 'method': self.command, 'target': self.path[:200]}) + '\n')
        self.send_response(403)
        self.send_header('Content-Length', '0')
        self.send_header('Connection', 'close')
        self.end_headers()

    do_CONNECT = refuse
    do_GET = refuse
    do_POST = refuse


ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
