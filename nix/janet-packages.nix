pkgs:
let
  inherit (pkgs.lib) fileset;
  root = ../.;
  hooks = ../packages/harness-hooks/src;
  feed = ../apps/astrolabe/feed;
  tasks = ../apps/tasks/scripts;
  vault = ../packages/vault-engine/scripts;
  watcher = ../apps/vuln-watch;
  promiseFiles = [
    (hooks + "/promise-ledger.ts")
    (hooks + "/promise-close.ts")
    (hooks + "/promise-detect.ts")
    (hooks + "/promise-due.ts")
  ];

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
  fold-cards = pkgs.runCommand "fold-cards" { src = ../apps/fold-cards; } ''
    cp -R "$src" "$out"
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

  astrolabe-quota = nodeScripts {
    name = "astrolabe-quota";
    files = [
      (hooks + "/quota.ts")
      (hooks + "/quota-sources.ts")
      (hooks + "/quota-watch.ts")
    ];
    commands.quota = "packages/harness-hooks/src/quota.ts";
  };

  astrolabe-feed = nodeScripts {
    name = "astrolabe-feed";
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
