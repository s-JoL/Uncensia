"""Deterministic local iOS interaction fixture (stdlib; 127.0.0.1:18095).

This is deliberately separate from the real backend and delayed-image fixture.
The UI tests control completion; a run continues while its client is backgrounded.
POST /__fixture/reset before each test. No credentials or user data are needed.
"""
import json
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse


CONVERSATIONS = ["stream-fixture", "settled-fixture", "alternate-fixture", "render-fixture"]
NOTE = {"id": "fixture-note", "name": "Attach this exact note.txt", "mime": "text/plain",
        "bytes": 37, "source": "upload", "embeddingStatus": "ready"}
QUOTE_ID = "quote_0123456789abcdef0123456789abcdef"
ORIGINAL = "Exact original text: keep line one.\nKeep the second line unchanged."


def history(conversation):
    return [{"id": f"{conversation}-{i}", "seq": i, "role": "assistant",
             "content": f"History anchor {i:03d}\n\n"
                        "A stable paragraph for reading. The client must preserve its position "
                        "while the assistant writes, the keyboard opens, and earlier messages arrive.\n\n"
                        + ("SETTLED ANSWER END" if i == 79 else f"History ending {i:03d}")}
            for i in range(80)]


class Fixture:
    def __init__(self):
        self.condition = threading.Condition(threading.RLock())
        self.reset()

    def reset(self, hold_quotes=False, initial_chunks=None):
        with self.condition:
            self.epoch = uuid.uuid4().hex
            self.messages = {key: history(key) for key in CONVERSATIONS}
            self.messages["render-fixture"][-1]["content"] = (
                "### Formula and original-source rendering\n\n"
                "Inline math: $x^2 + y^2 = z^2$.\n\n"
                "$$\\frac{1}{2} + \\sqrt{4} = \\frac{5}{2}$$\n\n"
                "**Formula $x^2$ stays bold**\n\n"
                "| Term | Value |\n| --- | --- |\n| Fraction | $\\frac{1}{2}$ |\n\n"
                f"[Exact source excerpt](excerpt://{QUOTE_ID})\n\nQuote loading anchor\n\n"
                + "Following paragraph. This later content keeps the source-reading anchor away from the live-following edge.\n\n" * 5
                + "SETTLED ANSWER END")
            self.runs = {}
            self.commands = []
            self.submissions = []
            self.older_requests = []
            self.resource_reads = []
            self.imports = []
            self.feedback = []
            self.delivery_review = None
            self.failed_feedback = False
            self.hold_quotes = hold_quotes
            self.initial_chunks = initial_chunks
            self.quote_deliveries = 0
            self.condition.notify_all()

    def summary(self, conversation):
        active = next((run for run in self.runs.values()
                       if run["conversation"] == conversation and run["status"] == "running"), None)
        messages = self.messages.get(conversation, [])
        return {"id": conversation, "title": conversation, "modelId": "fixture-model",
                "updatedAt": len(messages), "lastMessageSeq": messages[-1]["seq"] if messages else -1,
                "activeRun": {"id": active["id"], "resumeSeq": 0} if active else None}

    def emit(self, run, kind, data):
        run["events"].append({"seq": len(run["events"]) + 1, "type": kind, "data": data})
        self.condition.notify_all()

    def start(self, conversation, payload, key):
        with self.condition:
            existing = next((run for run in self.runs.values() if key and run["key"] == key), None)
            if existing:
                return existing
            run_id = uuid.uuid4().hex
            messages = self.messages.setdefault(conversation, [])
            message = {"id": f"user-{run_id}", "seq": len(messages), "role": "user", "content": payload["text"]}
            messages.append(message)
            run = {"id": run_id, "conversation": conversation, "status": "running", "events": [],
                   "text": "", "chunks": 0, "key": key, "paused": False, "epoch": self.epoch,
                   "chunk_limit": self.initial_chunks}
            self.runs[run_id] = run
            self.submissions.append({"conversation": conversation, **payload})
            self.emit(run, "message.end", {"messageId": message["id"], "message": message})
            self.emit(run, "message.start", {"message": {"role": "assistant"}})
            threading.Thread(target=self.generate, args=(run,), daemon=True).start()
            return run

    def generate(self, run):
        while True:
            time.sleep(0.12)
            with self.condition:
                if run["epoch"] != self.epoch or run["status"] != "running":
                    return
                if run["paused"] or (run["chunk_limit"] is not None and run["chunks"] >= run["chunk_limit"]):
                    continue
                self.append_chunk(run)

    def append_chunk(self, run):
        run["chunks"] += 1
        count = run["chunks"]
        # Variable block heights exercise headings, lists, tables and code-fence transitions.
        if count % 12 == 0:
            delta = f"\n\n### Stream section {count:03d}\n\n| Item | Value |\n| --- | --- |\n| Progress | {count} |\n\n"
        elif count % 12 == 4:
            delta = "\n\n```swift\nlet reply = \"streaming\"\nprint(reply)\n```\n\n"
        else:
            delta = f"Stream marker {count:03d}. A visible incremental paragraph with 中文文本 and emoji 🌊.\n\n"
        run["text"] += delta
        self.emit(run, "message.delta", {"assistantMessageEvent": {"type": "text_delta", "delta": delta}})

    def complete(self, run, minimum_chunks=0):
        if run["status"] != "running":
            return
        # Exercise the real SSE-to-canonical transition with a long transcript,
        # without spending minutes typing and blindly scrolling past its tail.
        while run["chunks"] < minimum_chunks:
            self.append_chunk(run)
        delta = "\n\nFINAL ANSWER END"
        run["text"] += delta
        self.emit(run, "message.delta", {"assistantMessageEvent": {"type": "text_delta", "delta": delta}})
        messages = self.messages[run["conversation"]]
        message = {"id": f"assistant-{run['id']}", "seq": len(messages), "role": "assistant", "content": run["text"]}
        messages.append(message)
        self.emit(run, "message.end", {"messageId": message["id"], "message": message})
        run["status"] = "completed"
        self.emit(run, "run.completed", {})


fixture = Fixture()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, value, status=200, mime="application/json"):
        body = json.dumps(value, ensure_ascii=False).encode() if mime == "application/json" else value
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        payload = json.loads(raw) if raw else {}
        path = urlparse(self.path).path.removeprefix("/v1")
        if path == "/__fixture/reset":
            initial_chunks = payload.get("initialChunks")
            if initial_chunks is not None and (type(initial_chunks) is not int or not 1 <= initial_chunks <= 64):
                return self.reply({"error": {"message": "initialChunks must be 1–64"}}, 400)
            fixture.reset(payload.get("holdQuotes", False), initial_chunks)
            return self.reply({"ok": True})
        if path == "/__fixture/release-stream":
            with fixture.condition:
                for run in fixture.runs.values():
                    run["chunk_limit"] = None
                    run["paused"] = False
                fixture.condition.notify_all()
            return self.reply({"ok": True})
        if path == "/__fixture/release-quote":
            with fixture.condition:
                fixture.hold_quotes = False
                fixture.condition.notify_all()
            return self.reply({"ok": True})
        if path in ["/__fixture/complete", "/__fixture/pause"]:
            minimum_chunks = payload.get("minimumChunks", 0)
            if type(minimum_chunks) is not int or not 0 <= minimum_chunks <= 2000:
                return self.reply({"error": {"message": "minimumChunks must be 0–2000"}}, 400)
            with fixture.condition:
                for run in fixture.runs.values():
                    if path.endswith("complete"):
                        fixture.complete(run, minimum_chunks)
                    else:
                        run["paused"] = payload.get("paused", True)
            return self.reply({"ok": True})
        if path == "/auth/token":
            return self.reply({"token": "local-streaming-fixture"})
        if path == "/resources/acquire":
            with fixture.condition:
                fixture.imports.append(payload["url"])
            return self.reply({"file_id": "imported-note", "indexing": "ready", "index_error": None})
        if path == "/resources/feedback":
            with fixture.condition:
                if payload.get("text") == "Retry this feedback once" and not fixture.failed_feedback:
                    fixture.failed_feedback = True
                    return self.reply({"error": {"message": "Fixture feedback save failed; retry the same text."}}, 400)
                fixture.feedback.append(payload)
            return self.reply({"saved": True})
        if path.endswith("/deliverables/fixture-delivery/review"):
            if payload.get("revision") != 2 or payload.get("status") not in ["accepted", "rejected"]:
                return self.reply({"error": {"message": "Invalid fixture review"}}, 400)
            with fixture.condition:
                fixture.delivery_review = payload["status"]
            return self.reply({"key": "fixture-delivery", "description": "Verified fixture delivery",
                               "status": "verified", "asset_id": "fixture-note", "revision": 2,
                               "review": {"status": payload["status"], "at": int(time.time() * 1000)}})
        if path == "/conversations":
            conversation = "new-" + uuid.uuid4().hex
            with fixture.condition:
                fixture.messages[conversation] = []
                return self.reply(fixture.summary(conversation))
        parts = path.strip("/").split("/")
        if len(parts) == 3 and parts[0] == "conversations":
            conversation, action = parts[1:]
            if action == "runs":
                run = fixture.start(conversation, payload, self.headers.get("Idempotency-Key"))
                return self.reply({"runId": run["id"], "seq": 0})
            if action in ["follow-up", "steer", "stop"]:
                with fixture.condition:
                    fixture.commands.append({"action": action, "conversation": conversation, **payload})
                    if action == "stop":
                        for run in fixture.runs.values():
                            if run["conversation"] == conversation:
                                fixture.complete(run)
                # Exposes duplicate taps and cross-conversation completion races.
                time.sleep(1.5)
                return self.reply({"ok": True})
        return self.reply({"error": {"message": f"Unsupported fixture POST: {path}"}}, 404)

    def do_GET(self):
        route = urlparse(self.path)
        path = route.path.removeprefix("/v1")
        query = parse_qs(route.query)
        if path == "/bootstrap":
            return self.reply({"models": [{"id": "fixture-model", "name": "Deterministic stream", "kind": "chat"}],
                               "defaultModelId": "fixture-model"})
        if path == "/__fixture/state":
            with fixture.condition:
                return self.reply({"commands": fixture.commands, "submissions": fixture.submissions,
                                   "olderRequests": fixture.older_requests,
                                   "resourceReads": fixture.resource_reads,
                                   "imports": fixture.imports, "feedback": fixture.feedback,
                                   "quoteDeliveries": fixture.quote_deliveries,
                                   "chunks": sum(run["chunks"] for run in fixture.runs.values())})
        if path == "/files":
            with fixture.condition:
                items = [NOTE]
                if fixture.imports:
                    items.append({**NOTE, "id": "imported-note", "name": "Imported original document.txt"})
            return self.reply({"items": items, "total": len(items), "facets": {"sources": []}})
        if path.startswith("/files/"):
            if path.endswith("/content"):
                return self.reply(ORIGINAL.encode(), mime="text/plain; charset=utf-8")
            return self.reply({**NOTE, "id": path.rsplit("/", 1)[-1]})
        if path.startswith("/resources/quotes/"):
            with fixture.condition:
                epoch = fixture.epoch
                fixture.condition.wait_for(lambda: not fixture.hold_quotes or fixture.epoch != epoch, 30)
                fixture.quote_deliveries += 1
            return self.reply({"text": ORIGINAL, "title": "Original fixture source", "start_line": 11,
                               "end_line": 12, "file_id": "file_0123456789abcdef0123456789abcdef", "version": 2})
        if path.startswith("/resources/sources/"):
            return self.reply([{"original_url": "https://example.com/original-fixture.txt",
                                "final_url": "https://example.com/original-fixture.txt", "fetched_at": "2026-09-12T00:00:00Z"}])
        if path.startswith("/resources/files/"):
            start = int(query.get("start", [1])[0])
            encoding = query.get("encoding", ["utf-8"])[0]
            with fixture.condition:
                fixture.resource_reads.append({"start": start, "encoding": encoding})
            return self.reply({"text": f"Original page at line {start}\nEncoding: {encoding}\n原文应逐字保留。",
                               "title": NOTE["name"], "next_line": start + 2 if start < 5 else None, "total_lines": 6})
        if path.startswith("/resources/conversations/") and path.endswith("/evidence"):
            review = {"status": fixture.delivery_review, "at": int(time.time() * 1000)} if fixture.delivery_review else None
            return self.reply({"deliverables": [{"key": "fixture-delivery", "description": "Verified fixture delivery",
                                "status": "verified", "asset_id": "fixture-note", "source_asset_id": "fixture-note",
                                "revision": 2, "review": review, "evidence": "Original file checked by the fixture."}],
                               "feedback": [{"entry_id": "fixture-entry", "text": "Keep the original wording."}]
                                + [{"entry_id": f"feedback-{i}", "text": value["text"]} for i, value in enumerate(fixture.feedback)],
                               "contexts": [{"runId": "fixture-run", "modelId": "fixture-model",
                                "modelInput": ["Original selected source, version 2"], "tools": ["read_resource"]}]})
        if path.endswith("/deliverables/fixture-delivery/versions"):
            return self.reply([
                {"key": "fixture-delivery", "description": "Verified fixture delivery", "status": "verified",
                 "asset_id": "fixture-note", "revision": 2},
                {"key": "fixture-delivery", "description": "Earlier fixture delivery", "status": "produced",
                 "asset_id": "fixture-note", "revision": 1},
            ])
        if path.endswith("/deliverables/fixture-delivery/compare"):
            return self.reply({"kind": "text", "patch": "-Earlier fixture line\n+Verified fixture line",
                               "from": {"revision": 1, "asset_id": "fixture-note"},
                               "to": {"revision": 2, "asset_id": "fixture-note"}})
        if path == "/conversations":
            with fixture.condition:
                return self.reply({"items": [fixture.summary(key) for key in fixture.messages], "nextCursor": None})
        parts = path.strip("/").split("/")
        if len(parts) >= 2 and parts[0] == "conversations":
            conversation = parts[1]
            if path.endswith("/approvals"):
                return self.reply({"items": []})
            if path.endswith("/messages"):
                if "before" in query:
                    with fixture.condition:
                        fixture.older_requests.append(int(query["before"][0]))
                    time.sleep(0.7)
                with fixture.condition:
                    messages = fixture.messages.get(conversation, [])
                    if "after" in query:
                        items = [item for item in messages if item["seq"] > int(query["after"][0])]
                        cursor = None
                    else:
                        end = int(query.get("before", [len(messages)])[0])
                        start = max(0, end - int(query.get("limit", [20])[0]))
                        items, cursor = messages[start:end], start if start else None
                    return self.reply({"items": items, "nextCursor": cursor})
            with fixture.condition:
                return self.reply(fixture.summary(conversation))
        if len(parts) >= 2 and parts[0] == "runs":
            with fixture.condition:
                run = fixture.runs.get(parts[1])
            if not run:
                return self.reply({"error": {"message": "Unknown fixture run"}}, 404)
            if not path.endswith("/events"):
                return self.reply({"id": run["id"], "status": run["status"]})
            after = int(query.get("after", [0])[0])
            if query.get("mode") == ["poll"]:
                with fixture.condition:
                    fixture.condition.wait_for(lambda: len(run["events"]) > after or run["status"] != "running", 2)
                    return self.reply({"events": run["events"][after:], "done": run["status"] != "running"})
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            try:
                while True:
                    with fixture.condition:
                        fixture.condition.wait_for(lambda: len(run["events"]) > after or run["epoch"] != fixture.epoch, 2)
                        if run["epoch"] != fixture.epoch:
                            return
                        events = run["events"][after:]
                        done = run["status"] != "running"
                    for event in events:
                        data = json.dumps(event, ensure_ascii=False)
                        self.wfile.write(f"event: {event['type']}\ndata: {data}\n\n".encode())
                        self.wfile.flush()
                        after = event["seq"]
                    if done:
                        return
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        return self.reply({"error": {"message": f"Unsupported fixture GET: {path}"}}, 404)


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", 18095), Handler)
    server.daemon_threads = True
    server.serve_forever()
