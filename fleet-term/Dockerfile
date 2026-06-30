# ttyd + tmux for the fleet agent-session view (#547). Attaches to the HOST tmux socket
# (mounted) so it mirrors the live agent-session session. Runs as uid 1000 (host docker user
# owns the socket). Bound inside-container only — reachable on the tasks docker network, NOT
# host-localhost (Bob's container-isolation; no SSRF surface from host processes).
FROM alpine:3.20
RUN apk add --no-cache tmux ca-certificates \
 && wget -qO /usr/local/bin/ttyd https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.x86_64 \
 && chmod +x /usr/local/bin/ttyd
USER 1000:1000
# command supplied by compose (ro vs rw)
ENTRYPOINT ["/usr/local/bin/ttyd"]
