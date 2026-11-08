# ttyd + tmux for the fleet agent-session view (#547). Attaches to the HOST tmux socket
# (mounted) so it mirrors the live tracker-session session. Runs as uid 1000 (host docker user
# owns the socket). Bound inside-container only — reachable on the tasks docker network, NOT
# host-localhost (an operator's container-isolation; no SSRF surface from host processes).
FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc
# Pin ttyd to a specific release + verify sha256 (supply-chain: never releases/latest, which is a
# moving target an upstream compromise could swap). Bump = update both the version and the hash.
ARG TTYD_VERSION=1.7.7
ARG TTYD_SHA256=8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55
RUN apk add --no-cache tmux ca-certificates \
 && wget -qO /usr/local/bin/ttyd "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.x86_64" \
 && echo "${TTYD_SHA256}  /usr/local/bin/ttyd" | sha256sum -c - \
 && chmod +x /usr/local/bin/ttyd
USER 1000:1000
# command supplied by compose (ro vs rw)
ENTRYPOINT ["/usr/local/bin/ttyd"]
