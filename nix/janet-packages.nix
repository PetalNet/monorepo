pkgs:
let
  inherit (pkgs.lib) fileset;
  root = ../.;
  hooks = ../packages/harness-hooks/src;
  feed = ../apps/astrolabe/feed;
  router = ../packages/router;
  tasks = ../apps/tasks/scripts;
  vault = ../packages/vault-engine/scripts;
  watcher = ../apps/vuln-watch;
  promiseFiles = [
    (hooks + "/message-source.ts")
    (hooks + "/promise-acceptance.ts")
    (hooks + "/promise-ledger.ts")
    (hooks + "/promise-close.ts")
    (hooks + "/promise-detect.ts")
    (hooks + "/promise-due.ts")
  ];

  effectVersion =
    let
      lines = pkgs.lib.splitString "\n" (builtins.readFile ../pnpm-workspace.yaml);
      catalog = pkgs.lib.findFirst (line: pkgs.lib.hasPrefix "  effect: " line)
        (throw "The pnpm catalog has no Effect version")
        lines;
    in
    pkgs.lib.removePrefix "  effect: " catalog;
  effectTarball =
    let
      lock = builtins.readFile ../pnpm-lock.yaml;
      entry = pkgs.lib.splitString "\n  effect@${effectVersion}:\n" lock;
      package =
        if builtins.length entry < 2 then
          throw "effect@${effectVersion} not in pnpm-lock.yaml; lock not updated"
        else
          builtins.elemAt entry 1;
      resolution = builtins.head (pkgs.lib.splitString "\n" package);
      integrity = builtins.match "    resolution: [{]integrity: (sha512-[^} ]+)[}]" resolution;
    in
    pkgs.fetchurl {
      url = "https://registry.npmjs.org/effect/-/effect-${effectVersion}.tgz";
      hash = builtins.head integrity;
    };

  nodeScripts =
    {
      name,
      files,
      commands,
      runtimeInputs ? [ ],
      extraInstall ? "",
    }:
    pkgs.runCommand name
      {
        src = fileset.toSource {
          inherit root;
          fileset = fileset.unions files;
        };
        nativeBuildInputs = [ pkgs.makeWrapper ];
      }
      ''
        mkdir -p "$out/lib" "$out/bin"
        cp -R "$src/." "$out/lib/"
        ${extraInstall}
        ${pkgs.lib.concatStringsSep "\n" (
          pkgs.lib.mapAttrsToList (command: script: ''
            makeWrapper ${pkgs.nodejs_22}/bin/node "$out/bin/${command}" \
              --add-flags "--no-warnings $out/lib/${script}" \
              ${pkgs.lib.optionalString (runtimeInputs != [ ]) ''
                --prefix PATH : ${pkgs.lib.makeBinPath runtimeInputs}
              ''}
          '') commands
        )}
      '';
in
rec {
  fold-cards = pkgs.runCommand "fold-cards" {
    src = ../apps/fold-cards;
    buildInputs = [ pkgs.bash pkgs.python3 ];
  } ''
    cp -R "$src" "$out"
    chmod -R u+w "$out/bin"
    patchShebangs --host "$out/bin"
    substituteInPlace "$out/bin/unfold" \
      --replace-fail 'exec python3 ' 'exec ${pkgs.python3}/bin/python3 ' \
      --replace-fail '$(dirname ' '$(${pkgs.coreutils}/bin/dirname '
    substituteInPlace "$out/bin/embed-setup" \
      --replace-fail 'python3 -m venv' '${pkgs.python3}/bin/python3 -m venv' \
      --replace-fail 'mkdir -p' '${pkgs.coreutils}/bin/mkdir -p'
    printf '%s\n' '${builtins.toJSON [ "${vault-scan}/bin/vault-scan" ]}' > "$out/bin/scanner-argv.json"
  '';

  harness-guards = nodeScripts {
    name = "harness-guards";
    files = [
      (hooks + "/agent-brief-guard.ts")
      (hooks + "/context-bundle.ts")
      (hooks + "/matrix-local-path-guard.ts")
    ];
    commands = {
      agent-brief-guard = "packages/harness-hooks/src/agent-brief-guard.ts";
      matrix-local-path-guard = "packages/harness-hooks/src/matrix-local-path-guard.ts";
    };
    runtimeInputs = [ pkgs.python3 ];
    extraInstall = ''
      mkdir -p "$out/lib/apps"
      ln -s ${fold-cards} "$out/lib/apps/fold-cards"
    '';
  };

  objectives-index = nodeScripts {
    name = "objectives-index";
    files = promiseFiles ++ [
      (hooks + "/objectives-index-ledger.ts")
      (hooks + "/objectives-prune.ts")
      (hooks + "/sessionstart-objectives.ts")
    ];
    commands = {
      sessionstart-objectives = "packages/harness-hooks/src/sessionstart-objectives.ts";
      objectives-prune = "packages/harness-hooks/src/objectives-prune.ts";
    };
  };

  promise-ledger = nodeScripts {
    name = "promise-ledger";
    runtimeInputs = [ vault-client ];
    files = promiseFiles ++ [ (hooks + "/promise.ts") ];
    commands.promise = "packages/harness-hooks/src/promise.ts";
  };

  janet-writer = nodeScripts {
    name = "janet-writer";
    files = [
      (hooks + "/janet-voice.ts")
      (hooks + "/plain.ts")
      ../skills/janet-voice/SKILL.md
    ];
    commands.janet-voice = "packages/harness-hooks/src/janet-voice.ts";
    extraInstall = ''
      mkdir -p "$out/workspace"
      ln -s lib/skills/janet-voice/SKILL.md "$out/SKILL.md"
      sed '1{/^---$/!q1}; 1,/^---$/d' "$out/SKILL.md" | sed '/./,$!d' > "$out/workspace/AGENTS.md"
      ln -s workspace/AGENTS.md "$out/gemma-system.txt"
    '';
  };

  vault-client = pkgs.runCommand "vault-client" { nativeBuildInputs = [ pkgs.makeWrapper ]; } ''
    install -Dm755 ${vault + "/client.sh"} "$out/lib/client.sh"
    install -Dm755 ${vault + "/remote.sh"} "$out/lib/remote.sh"
    patchShebangs "$out/lib"
    makeWrapper "$out/lib/client.sh" "$out/bin/vault-engine" \
      --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.openssh pkgs.coreutils pkgs.findutils ]}
  '';

  vault-scan = nodeScripts {
    name = "vault-scan";
    files = [
      ../packages/vault-engine/src/errors.ts
      ../packages/vault-engine/src/outbound-scan.ts
      ../packages/vault-engine/src/scan-cli.ts
      ../packages/vault-engine/src/secrets.ts
    ];
    commands.vault-scan = "packages/vault-engine/src/scan-cli.ts";
    extraInstall = ''
      mkdir -p "$out/lib/node_modules/effect"
      tar -xf ${effectTarball} --strip-components=1 -C "$out/lib/node_modules/effect"
    '';
  };

  astrolabe-quota = nodeScripts {
    name = "astrolabe-quota";
    runtimeInputs = [ pkgs.openssh ];
    files = [
      (hooks + "/quota.ts")
      (hooks + "/quota-sources.ts")
      (hooks + "/quota-watch.ts")
    ];
    commands.quota = "packages/harness-hooks/src/quota.ts";
  };

  quota-pacer = nodeScripts {
    name = "quota-pacer";
    runtimeInputs = [ pkgs.bash pkgs.coreutils pkgs.util-linux ];
    files = [
      (router + "/src")
      (router + "/package.json")
      (router + "/bin/quota-pace-reminder")
      hooks
      ../packages/harness-hooks/package.json
      (feed + "/codex-usage.ts")
      ../apps/astrolabe/src/lib/format.ts
    ];
    commands.quota-pace = "packages/router/src/route.ts pace";
    extraInstall = ''
      mkdir -p "$out/lib/node_modules/@petalnet"
      ln -s ../../packages/harness-hooks "$out/lib/node_modules/@petalnet/harness-hooks"
      patchShebangs "$out/lib/packages/router/bin/quota-pace-reminder"
      makeWrapper "$out/lib/packages/router/bin/quota-pace-reminder" "$out/bin/quota-pace-reminder" \
        --set QUOTA_PACE "$out/bin/quota-pace" \
        --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.coreutils pkgs.gawk ]}

      # Load the packaged module graph without contacting a provider.
      status=0
      ${pkgs.nodejs_22}/bin/node "$out/lib/packages/router/src/route.ts" pace unexpected \
        > "$TMPDIR/quota-pacer-smoke.log" 2>&1 || status=$?
      if [ "$status" -ne 2 ]; then
        cat "$TMPDIR/quota-pacer-smoke.log"
        exit 1
      fi
    '';
  };

  astrolabe-feed = nodeScripts {
    name = "astrolabe-feed";
    runtimeInputs = [ pkgs.nodejs_22 pkgs.openssh ];
    files = [
      (feed + "/claude-usage-snapshot.ts")
      (feed + "/codex-usage-snapshot.ts")
      (feed + "/codex-usage.ts")
      (feed + "/usage-fetch.ts")
      ../apps/astrolabe/src/lib/format.ts
    ];
    commands = {
      claude-usage-snapshot = "apps/astrolabe/feed/claude-usage-snapshot.ts";
      codex-usage-snapshot = "apps/astrolabe/feed/codex-usage-snapshot.ts";
      usage-fetch = "apps/astrolabe/feed/usage-fetch.ts";
    };
  };

  tasks-agents-snapshot = nodeScripts {
    name = "tasks-agents-snapshot";
    files = [
      (tasks + "/agents-snapshot.mjs")
      (tasks + "/agents-view")
      (tasks + "/publish-agents-snapshot.mjs")
    ];
    commands.tasks-agents-snapshot = "apps/tasks/scripts/publish-agents-snapshot.mjs";
  };

  vuln-watch = pkgs.runCommand "vuln-watch" { nativeBuildInputs = [ pkgs.makeWrapper ]; } ''
    mkdir -p "$out/lib"
    cp ${watcher}/{watcher,inventory,droplet,feeds,shawn_poster,ssh_poster}.py "$out/lib/"
    makeWrapper ${pkgs.python3}/bin/python3 "$out/bin/vuln-watch" \
      --add-flags "$out/lib/watcher.py" --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.openssh pkgs.nix ]}
    makeWrapper ${pkgs.python3}/bin/python3 "$out/bin/vuln-watch-shawn" \
      --add-flags "$out/lib/ssh_poster.py" --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.openssh ]}
  '';
}
