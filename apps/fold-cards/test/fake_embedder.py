"""A stand-in for bin/embedder.py: answers every search on embed.sock with fixed (rowid, cosine) hits."""
import json, socket, threading


class FakeEmbedder:
    def __init__(self, path, hits):
        self.srv = socket.socket(socket.AF_UNIX)
        self.srv.bind(path)
        self.srv.listen(4)
        self.hits, self.requests = hits, []
        threading.Thread(target=self.loop, daemon=True).start()

    def loop(self):
        while True:
            conn, _ = self.srv.accept()
            with conn:
                buf = b''
                while not buf.endswith(b'\n'):
                    buf += conn.recv(65536)
                self.requests.append(json.loads(buf))
                conn.sendall(json.dumps({'hits': self.hits}).encode() + b'\n')
