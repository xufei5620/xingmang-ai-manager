# 临时：核 Antigravity CLI 发给自定义地址的请求，核完就删。
# A Gemini-native fake endpoint that answers every model call with "pong" and
# appends one JSON line per request (or malformed request) to a log file.
import json
import re
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs

PORT = int(sys.argv[1])
LOG = sys.argv[2]
MODEL_CALL = re.compile(r'/models/([^/:]+):(streamGenerateContent|generateContent|countTokens|embedContent)$')


def write(entry):
    entry['t'] = round(time.time(), 3)
    with open(LOG, 'a', encoding='utf-8') as handle:
        handle.write(json.dumps(entry, ensure_ascii=False) + '\n')


def summarize(body):
    try:
        parsed = json.loads(body.decode('utf-8'))
    except Exception:
        return {'raw': body[:200].decode('utf-8', 'replace')}
    if not isinstance(parsed, dict):
        return {'type': type(parsed).__name__}
    summary = {'keys': sorted(parsed.keys())}
    if 'model' in parsed:
        summary['model'] = parsed['model']
    if isinstance(parsed.get('generationConfig'), dict):
        summary['generationConfig'] = parsed['generationConfig']
    tools = parsed.get('tools')
    if isinstance(tools, list):
        names = []
        for tool in tools:
            if isinstance(tool, dict):
                for key, value in tool.items():
                    if key == 'functionDeclarations' and isinstance(value, list):
                        names.append('functions:%d' % len(value))
                    else:
                        names.append(key)
        summary['tools'] = names
    contents = parsed.get('contents')
    if isinstance(contents, list):
        summary['contents'] = len(contents)
        texts = []
        for item in contents[-1:]:
            for part in (item.get('parts') or []) if isinstance(item, dict) else []:
                if isinstance(part, dict) and isinstance(part.get('text'), str):
                    texts.append(part['text'][-160:])
        summary['lastText'] = texts
    system = parsed.get('systemInstruction')
    if system is not None:
        summary['systemInstructionChars'] = len(json.dumps(system))
    return summary


def candidate(model):
    return {
        'candidates': [{
            'content': {'role': 'model', 'parts': [{'text': 'pong'}]},
            'finishReason': 'STOP',
            'index': 0,
        }],
        'usageMetadata': {'promptTokenCount': 5, 'candidatesTokenCount': 1, 'totalTokenCount': 6},
        'modelVersion': model,
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        pass

    def log_error(self, fmt, *args):
        write({'error': fmt % args, 'requestline': getattr(self, 'raw_requestline', b'')[:80].decode('latin-1')})

    def reply(self, status, payload, content_type='application/json'):
        data = payload if isinstance(payload, bytes) else json.dumps(payload).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def handle_any(self):
        length = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(length) if length else b''
        parts = urlsplit(self.path)
        query = parse_qs(parts.query)
        entry = {
            'method': self.command,
            'path': parts.path,
            'query': sorted(query.keys()),
            'ua': self.headers.get('User-Agent'),
            'apiClient': self.headers.get('x-goog-api-client'),
            'hasGoogKey': bool(self.headers.get('x-goog-api-key')),
            'googKeyMatches': self.headers.get('x-goog-api-key') == 'probe-fake-key',
            'hasAuthorization': bool(self.headers.get('Authorization')),
            'queryKey': 'key' in query,
            'headerNames': sorted(self.headers.keys()),
        }
        if body:
            entry['body'] = summarize(body)
        write(entry)
        match = MODEL_CALL.search(parts.path)
        if match:
            model, method = match.group(1), match.group(2)
            if method == 'countTokens':
                return self.reply(200, {'totalTokens': 5})
            if method == 'embedContent':
                return self.reply(200, {'embedding': {'values': [0.0] * 8}})
            if method == 'streamGenerateContent':
                chunk = 'data: ' + json.dumps(candidate(model)) + '\r\n\r\n'
                if 'alt' in query:
                    return self.reply(200, chunk.encode('utf-8'), 'text/event-stream')
                return self.reply(200, [candidate(model)])
            return self.reply(200, candidate(model))
        if parts.path.rstrip('/').endswith('/models'):
            return self.reply(200, {'models': [
                {'name': 'models/gemini-3.8-flash-high', 'displayName': 'Relay Flash High',
                 'supportedGenerationMethods': ['generateContent', 'streamGenerateContent', 'countTokens']},
            ]})
        return self.reply(404, {'error': {'code': 404, 'message': 'not found in fake', 'status': 'NOT_FOUND'}})

    do_GET = handle_any
    do_POST = handle_any
    do_PUT = handle_any
    do_DELETE = handle_any


ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
