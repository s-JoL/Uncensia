"""Local-only deterministic slow-image fixture for MediaScrollTests (stdlib only)."""
import json
import struct
import threading
import uuid
import time
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs


def png(width, height):
    def chunk(kind, data):
        return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data))
    pixels = (b'\0' + bytes([40, 135, 160]) * width) * height
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(pixels)) + chunk(b'IEND', b'')


class ImageDeliveryGate:
    def __init__(self):
        self.condition = threading.Condition(threading.RLock())
        self.reset(controlled=False)

    def reset(self, hold=False, controlled=True):
        with self.condition:
            self.epoch = uuid.uuid4().hex
            self.controlled = controlled
            self.hold = hold
            # Every controlled run uses fresh URLs so URLSession cannot satisfy
            # the acceptance scenario from a previous run's disk cache.
            self.prefix = f"img_{self.epoch}_" if controlled else "img_"
            self.requested = set()
            self.delivered = set()
            self.condition.notify_all()
            return self.state()

    def state(self):
        return {"epoch": self.epoch, "imagePrefix": self.prefix, "held": self.hold,
                "requested": sorted(self.requested), "delivered": sorted(self.delivered),
                "portraitDelivered": sum(i % 2 == 1 for i in self.delivered),
                "landscapeDelivered": sum(i % 2 == 0 for i in self.delivered)}


gate = ImageDeliveryGate()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, value, mime='application/json', status=200):
        body = json.dumps(value).encode() if mime == 'application/json' else value
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
            self.wfile.flush()
            return True
        except (BrokenPipeError, ConnectionResetError):
            return False

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        payload = json.loads(raw) if raw else {}
        path = urlparse(self.path).path.removeprefix('/v1')
        if path == '/__fixture/reset':
            return self.reply(gate.reset(hold=payload.get('hold', False)))
        if path == '/__fixture/release':
            with gate.condition:
                gate.hold = False
                gate.condition.notify_all()
                state = gate.state()
            return self.reply(state)
        self.reply({'token': 'local-scroll-fixture'})

    def do_GET(self):
        route = urlparse(self.path)
        path = route.path.removeprefix('/v1')
        summary = {'id': 'scroll-fixture', 'title': 'Delayed image scrolling', 'modelId': 'fixture-model', 'updatedAt': 1, 'activeRun': None}
        if path == '/__fixture/state':
            query = parse_qs(route.query)
            required = {int(value) for value in query.get('waitForImages', [''])[0].split(',') if value}
            with gate.condition:
                epoch = gate.epoch
                if required:
                    gate.condition.wait_for(lambda: required.issubset(gate.delivered) or epoch != gate.epoch, 12)
                state = gate.state()
            return self.reply(state)
        if path.startswith('/images/'):
            index = int(path.rsplit('_', 1)[-1])
            with gate.condition:
                if gate.controlled and not path.rsplit('/', 1)[-1].startswith(gate.prefix):
                    return self.reply({'error': 'Image belongs to an earlier fixture run'}, status=409)
                epoch = gate.epoch
                controlled = gate.controlled
                gate.requested.add(index)
                gate.condition.notify_all()
                gate.condition.wait_for(lambda: not gate.hold or epoch != gate.epoch)
                if epoch != gate.epoch:
                    return self.reply({'error': 'Fixture was reset'}, status=409)
            if not controlled:
                time.sleep(8)  # Preserve the original fixture's default behavior.
            delivered = self.reply(png(40 if index % 2 else 240, 240 if index % 2 else 40), 'image/png')
            with gate.condition:
                if delivered and epoch == gate.epoch:
                    gate.delivered.add(index)
                    gate.condition.notify_all()
        elif path == '/bootstrap':
            self.reply({'models': [{'id': 'fixture-model', 'name': 'Fixture', 'kind': 'chat'}], 'defaultModelId': 'fixture-model'})
        elif path == '/conversations':
            self.reply({'items': [summary], 'nextCursor': None})
        elif path.endswith('/messages'):
            query = parse_qs(route.query)
            end = int(query.get('before', [80])[0])
            start = max(0, end - int(query.get('limit', [20])[0]))
            with gate.condition:
                prefix = gate.prefix
            self.reply({'items': [{'id': f'message-{i}', 'seq': i, 'role': 'assistant', 'content': f'Read marker {i}\n\n![Delayed image](image://{prefix}{i})\n\nEnd marker {i}'} for i in range(start, end)], 'nextCursor': start if start else None})
        elif path.endswith('/approvals'):
            self.reply({'items': []})
        else:
            self.reply(summary)


if __name__ == '__main__':
    server = ThreadingHTTPServer(('127.0.0.1', 18094), Handler)
    server.daemon_threads = True
    server.serve_forever()
