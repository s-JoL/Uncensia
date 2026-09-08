"""Local-only deterministic slow-image fixture for MediaScrollTests (stdlib only)."""
import json
import struct
import time
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs


def png(width, height):
    def chunk(kind, data):
        return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data))
    pixels = (b'\0' + bytes([40, 135, 160]) * width) * height
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(pixels)) + chunk(b'IEND', b'')


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, value, mime='application/json'):
        body = json.dumps(value).encode() if mime == 'application/json' else value
        self.send_response(200)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_POST(self):
        self.rfile.read(int(self.headers.get('Content-Length', '0')))
        self.reply({'token': 'local-scroll-fixture'})

    def do_GET(self):
        route = urlparse(self.path)
        path = route.path.removeprefix('/v1')
        summary = {'id': 'scroll-fixture', 'title': 'Delayed image scrolling', 'modelId': 'fixture-model', 'updatedAt': 1, 'activeRun': None}
        if path.startswith('/images/'):
            time.sleep(8)
            index = int(path.rsplit('_', 1)[-1])
            self.reply(png(40 if index % 2 else 240, 240 if index % 2 else 40), 'image/png')
        elif path == '/bootstrap':
            self.reply({'models': [{'id': 'fixture-model', 'name': 'Fixture', 'kind': 'chat'}], 'defaultModelId': 'fixture-model'})
        elif path == '/conversations':
            self.reply({'items': [summary], 'nextCursor': None})
        elif path.endswith('/messages'):
            query = parse_qs(route.query)
            end = int(query.get('before', [80])[0])
            start = max(0, end - int(query.get('limit', [20])[0]))
            self.reply({'items': [{'id': f'message-{i}', 'seq': i, 'role': 'assistant', 'content': f'Read marker {i}\n\n![Delayed image](image://img_{i})\n\nEnd marker {i}'} for i in range(start, end)], 'nextCursor': start if start else None})
        elif path.endswith('/approvals'):
            self.reply({'items': []})
        else:
            self.reply(summary)


if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', 18094), Handler).serve_forever()
