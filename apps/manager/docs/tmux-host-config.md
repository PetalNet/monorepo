# Host tmux + ttyd declarative config — SPEC ONLY, NOT APPLIED

> **Status: reviewable spec (N1.2).** Nothing here is installed by this
> node. The `janet-nix` repo (not checked out on this host) owns the real
> `modules/home/{tmux,ttyd}.nix`; this document plus
> [`tmux.conf.reviewable`](./tmux.conf.reviewable) are written so those
> modules can adopt the content verbatim. Until then the live host keeps
> its hand-managed config.

## 1. The one-version rule

**Exactly one tmux version on the host, pinned: 3.4.** Why 3.4 and why
one:

- The manager requires **tmux ≥ 3.0** (pane _user options_ carry the
  `@agent_manager_owner` ownership tag; a tmux without them is a failed
  spawn, never degraded operation — locked N1.2 decision).
- Mixed tmux client/server versions on one socket have historically
  produced "server version is too old/newer than client" failures, and
  version-dependent behavior skew is real even when the connection works
  (3.4/3.5 sanitize control characters in list output where 3.6 does not
  — that skew hid a live bug, F2 in DECISIONS-N1.2). The manager's own
  CLI tolerates 3.4–3.6 (validated), but ONE pinned version removes the
  whole class.
- The fleet-term containers (`tasks/fleet-term`, Alpine 3.20) attach
  their **containerized tmux client to the HOST server socket** —
  Alpine 3.20 ships tmux 3.4, so the host pin and the container base
  image must move **together**. Bumping one without the other breaks the
  web terminal, not the manager (the manager never crosses the container
  boundary), but treat it as one atomic upgrade anyway.

nixpkgs note for janet-nix: pin the tmux package to 3.4 (or hold the
module's nixpkgs input on a revision that ships it); do not track
`nixpkgs-unstable` for this package.

## 2. Socket contract (fleet-term consumer, N1.7)

| Item                  | Value                                             | Why                                                                                                       |
| --------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Server socket         | `/tmp/tmux-1000/default`                          | tmux default for uid 1000; both ttyd containers hard-code it                                              |
| Socket dir owner/mode | uid 1000, `0700` (tmux default)                   | containers run `USER 1000:1000` and bind-mount `/tmp/tmux-1000` — same-uid access, no group/world opening |
| Shared session name   | `janet-claude`                                    | ro view: `tmux -S /tmp/tmux-1000/default attach -r -t janet-claude`; rw: same without `-r`                |
| tmpfiles / cleanup    | `/tmp/tmux-1000` must be exempt from tmp sweepers | a swept socket kills every attached client and orphans the server                                         |

Constraints the manager adds on top:

- The manager identifies its pane by **pane id + user option**, never by
  session name alone, so humans and ttyd clients may open/close panes and
  windows in `janet-claude` freely.
- Respawns go into a **new window**; only the manager's own tagged pane
  is ever killed. Nothing in the host config may set `remain-on-exit on`
  (see the conf file — it would defeat exit detection).
- Session names must not be prefix-ambiguous _by policy_ (the layer now
  pins exact-name targeting — `=name:` — but sibling sessions like
  `janet-claude-scratch` remain confusing for humans; prefer distinct
  names).

## 3. `modules/home/tmux.nix` — content to adopt

```nix
# janet-nix modules/home/tmux.nix — adopt verbatim from
# apps/manager/docs/ in PetalNet/monorepo (N1.2 spec).
{ pkgs, ... }:
{
  # ONE tmux on the host, pinned 3.4 (see the one-version rule).
  # Assert rather than drift: fail the build if nixpkgs moves.
  home.packages = [ pkgs.tmux ];
  assertions = [{
    assertion = pkgs.lib.hasPrefix "3.4" pkgs.tmux.version;
    message = "host tmux must stay pinned to 3.4 (manager + fleet-term contract)";
  }];

  # The manager does not need tmux started at boot: its first spawn boots
  # the server (new-session) on the default socket.
  xdg.configFile."tmux/tmux.conf".text = ''
    ... contents of tmux.conf.reviewable, verbatim ...
  '';
}
```

## 4. `modules/home/ttyd.nix` — content to adopt

The current live consumers are the _containerized_ ttyd pair in the tasks
stack (`docker-compose.fleet-term.yml`, reachable only on the tasks docker
network). If/when janet-nix also wants host-level ttyd services, this is
the contract; otherwise the module can stay empty and defer to the
containers.

```nix
# janet-nix modules/home/ttyd.nix — adopt verbatim (N1.2 spec).
{ pkgs, ... }:
let
  socket = "/tmp/tmux-1000/default";
  session = "janet-claude";
  # Pin ttyd like the container does (1.7.7); never "latest".
  ttyd = "${pkgs.ttyd}/bin/ttyd";
in
{
  # Read-only mirror of the shared session. Loopback ONLY — anything
  # network-facing goes through the tasks proxy, same as the containers.
  systemd.user.services.ttyd-ro = {
    Unit.Description = "ttyd read-only view of ${session}";
    Service = {
      ExecStart = "${ttyd} -i 127.0.0.1 -p 7681 ${pkgs.tmux}/bin/tmux -S ${socket} attach -r -t ${session}";
      Restart = "on-failure";
    };
    Install.WantedBy = [ "default.target" ];
  };

  # Writable variant (7682, ttyd -W). Gate it behind the app's admin
  # check exactly like the container pair; do not enable by default.
  systemd.user.services.ttyd-rw = {
    Unit.Description = "ttyd writable attach to ${session}";
    Service = {
      ExecStart = "${ttyd} -W -i 127.0.0.1 -p 7682 ${pkgs.tmux}/bin/tmux -S ${socket} attach -t ${session}";
      Restart = "on-failure";
    };
    Install.WantedBy = [ ];  # opt-in, not auto-started
  };
}
```

Notes for the janet-nix porter:

- `pkgs.ttyd` must be 1.7.7 to match the container pin (same
  supply-chain reasoning: the containers verify a release sha256; nix
  pins by derivation).
- The nix-level tmux used by ttyd's attach command **is the same pinned
  3.4** — the one-version rule again.
- The containerized pair stays authoritative until janet-nix decides
  otherwise; running both host services and containers simultaneously is
  fine (they are just extra clients on the socket) but pointless.

## 5. What this node deliberately did NOT do

- No clone/edit of janet-nix (not checked out; per directive).
- No change to `/home/docker/tasks/fleet-term/*` (owned by N1.7; the
  socket contract above is the coordination artifact).
- No live tmux/ttyd config change, restart, or version bump on this
  host.
