"""Per-session call control, shared with Claude's stdio MCP process over a private Unix socket."""

import json
import socket
import socketserver
import sys
import tempfile
import threading
from pathlib import Path

SERVER = "janet_call"
QUESTION = "Is there anything else you'd like to discuss?"
GOODBYE = "Okay, talk later."
DESCRIPTIONS = {
    "ask_to_end_call": "Queue the spoken closing question before ending this call. Use when the caller seems done, even if they directly requested hangup. Use this tool instead of asking the question yourself: the head appends it after your reply. This does not end the call.",
    "end_call": "End this call only when the caller's current turn confirms nothing else remains after the head's closing question on the previous turn. Interpret the entire caller turn: a new topic, uncertainty, or a request to continue is not consent. The head speaks one goodbye, then signals the client to end after playback. Extra model speech on this turn is discarded. Refused without a completed question on the immediately previous turn.",
}
NAMES = tuple(f"mcp__{SERVER}__{name}" for name in DESCRIPTIONS)


class CallControl:
    def __init__(self):
        self._lock = threading.Lock()
        self._active = self._ready = self._eligible = self._question = self._end = False
        self._closed = False
        self._directory = tempfile.TemporaryDirectory(prefix="janet-call-")
        self.path = str(Path(self._directory.name) / "control.sock")
        control = self

        class Handler(socketserver.StreamRequestHandler):
            def handle(self):
                self.request.settimeout(3)
                try:
                    request = json.loads(self.rfile.readline(4096))
                    result = control.call(request.get("name"), request.get("arguments"))
                    self.wfile.write(json.dumps(result).encode() + b"\n")
                except (OSError, ValueError, AttributeError):
                    return

        self._server = socketserver.ThreadingUnixStreamServer(self.path, Handler)
        self._server.daemon_threads = True
        threading.Thread(target=self._server.serve_forever, daemon=True).start()

    def mcp_config(self) -> dict:
        return {SERVER: {"command": sys.executable, "args": ["-I", str(Path(__file__).resolve()), self.path]}}

    def begin_turn(self) -> bool:
        """Return whether this turn answers the previous closing question."""
        with self._lock:
            self._active, self._eligible = True, self._ready
            self._ready = self._question = self._end = False
            return self._eligible

    def interrupt(self) -> None:
        with self._lock:
            self._active = self._ready = self._eligible = self._question = self._end = False

    def finish_turn(self, completed: bool) -> tuple[bool, bool]:
        with self._lock:
            question, end = completed and self._question, completed and self._end
            self._active, self._ready = False, question
            return question, end

    @property
    def closing_queued(self) -> bool:
        with self._lock:
            return self._question or self._end

    @property
    def end_requested(self) -> bool:
        with self._lock:
            return self._end

    def call(self, name: str, arguments: dict) -> dict:
        with self._lock:
            if name not in DESCRIPTIONS or arguments != {}:
                message, error = "Only the listed call tools with empty arguments are allowed.", True
            elif not self._active:
                message, error = "Call control is unavailable outside a live caller turn.", True
            elif name == "ask_to_end_call":
                self._question, self._eligible, self._end = True, False, False
                message, error = "The closing question is queued for playback after your reply. The call stays open for the caller to answer.", False
            elif not self._eligible or self._question:
                message, error = "No completed closing question on the immediately previous turn. Use ask_to_end_call and wait for a later caller turn.", True
            else:
                self._end = True
                message, error = "Goodbye is queued for playback. The client may end after playing it.", False
            return {"content": [{"type": "text", "text": message}], "isError": error}

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self.interrupt()
        self._server.shutdown()
        self._server.server_close()
        self._directory.cleanup()


def respond(request: dict, path: str) -> dict | None:
    if "id" not in request:
        return None
    method, result = request.get("method"), {}
    if method == "initialize":
        result = {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}}, "serverInfo": {"name": SERVER, "version": "1.0"}}
    elif method == "tools/list":
        result = {"tools": [{"name": name, "description": description, "inputSchema": {
            "type": "object", "properties": {}, "additionalProperties": False},
            "annotations": {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": False},
        } for name, description in DESCRIPTIONS.items()]}
    elif method == "tools/call":
        try:
            with socket.socket(socket.AF_UNIX) as client:
                client.settimeout(3)
                client.connect(path)
                client.sendall(json.dumps(request.get("params") or {}).encode() + b"\n")
                with client.makefile("rb") as response:
                    result = json.loads(response.readline(4096))
        except (OSError, ValueError):
            result = {"content": [{"type": "text", "text": "Call control unavailable. The call has not been ended."}], "isError": True}
    elif method != "ping":
        return {"jsonrpc": "2.0", "id": request["id"], "error": {"code": -32601, "message": "Method not found"}}
    return {"jsonrpc": "2.0", "id": request["id"], "result": result}


if __name__ == "__main__":
    for line in sys.stdin.buffer:
        try:
            response = respond(json.loads(line), sys.argv[1])
            if response is not None:
                print(json.dumps(response), flush=True)
        except (ValueError, TypeError, AttributeError):
            print(json.dumps({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Invalid request"}}), flush=True)
