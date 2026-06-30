// Custom adapter-node entry: serves the SvelteKit app AND proxies the fleet-terminal
// websocket. WebSockets can't be expressed in a SvelteKit +server endpoint, so the proxy
// lives here at the HTTP-upgrade layer. It bridges ttyd's framed protocol (1-byte command
// prefix) to a RAW byte stream for the ghostty-web client (which expects raw .write/.onData).
//
// Routes:
//   /api/fleet/term/ro  -> ttyd-ro container (tmux attach -r, read-only)   [any ALLOW user]
//   /api/fleet/term/rw  -> ttyd-rw container (tmux attach, writable)        [ADMIN only]
// Auth: Traefik forward-auth injects x-authentik-username on the upgrade request (same as
// hooks.server.js). Fail-closed. The ro path also DROPS client->server input as defense-in-depth
// on top of ttyd's read-only tmux client.
import http from 'node:http';
import { handler } from './build/handler.js';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = process.env.PORT || 8896;
const ALLOW = (process.env.ALLOW || '').split(',').map((s) => s.trim()).filter(Boolean);
const ADMIN = (process.env.TERM_ADMIN || 'alice,bob').split(',').map((s) => s.trim()).filter(Boolean);
const TTYD = {
  ro: process.env.TTYD_RO || 'ws://tasks-ttyd-ro:7681/ws',
  rw: process.env.TTYD_RW || 'ws://tasks-ttyd-rw:7682/ws'
};

const server = http.createServer(handler);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { return socket.destroy(); }
  const m = url.pathname.match(/^\/api\/fleet\/term\/(ro|rw)$/);
  if (!m) return; // not a terminal ws — SvelteKit has no other upgrade route
  const mode = m[1];
  const user = req.headers['x-authentik-username'] || '';
  // fail-closed: rw demands an ADMIN identity; ro demands any ALLOW user (any authed if no ALLOW set)
  const ok = mode === 'rw' ? ADMIN.includes(user) : (ALLOW.length ? ALLOW.includes(user) : !!user);
  if (!ok) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (client) => bridge(client, mode));
});

const TTYD_OUTPUT = 0x30; // '0' command = terminal output (ttyd server -> client)
const TTYD_INPUT = Buffer.from('0'); // '0' command = stdin (client -> ttyd server)
const TTYD_RESIZE = '1'; // '1' command = resize (client -> ttyd server)

function bridge(client, mode) {
  const upstream = new WebSocket(TTYD[mode], { perMessageDeflate: false });
  let upOpen = false;
  upstream.on('open', () => {
    upOpen = true;
    // ttyd's mandatory init frame (no credential set on our ttyd, so AuthToken is empty)
    upstream.send(JSON.stringify({ AuthToken: '', columns: 120, rows: 32 }));
  });
  upstream.on('message', (data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length && buf[0] === TTYD_OUTPUT) {
      // strip the command byte -> raw terminal bytes for ghostty-web .write()
      if (client.readyState === WebSocket.OPEN) client.send(buf.subarray(1));
    }
    // ignore '1' (set-title) / '2' (set-prefs)
  });
  client.on('message', (data, isBinary) => {
    if (!upOpen) return;
    if (isBinary) {
      // raw stdin from ghostty-web .onData(); RO drops it (defense-in-depth)
      if (mode === 'rw') {
        const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
        upstream.send(Buffer.concat([TTYD_INPUT, b]));
      }
    } else {
      // text control frame: { type:'resize', cols, rows }
      try {
        const j = JSON.parse(data.toString());
        if (j && j.type === 'resize' && j.cols && j.rows) {
          upstream.send(TTYD_RESIZE + JSON.stringify({ columns: j.cols, rows: j.rows }));
        }
      } catch { /* ignore malformed control frames */ }
    }
  });
  const close = () => { try { client.close(); } catch {} try { upstream.close(); } catch {} };
  client.on('close', close);
  client.on('error', close);
  upstream.on('close', close);
  upstream.on('error', () => { if (client.readyState === WebSocket.OPEN) client.close(1011); });
}

server.listen(PORT, () => console.log(`tasks (svelte handler + fleet-term ws proxy) listening on :${PORT}`));
