{
  description = "PetalNet monorepo packages and dev shells";

  inputs = {
    nixpkgs.url = "https://channels.nixos.org/nixos-unstable/nixexprs.tar.zst";
    # The last release that packages Prisma 5 engines (5.22.0), which Slide pins.
    nixpkgs-prisma5.url = "https://channels.nixos.org/nixos-24.11/nixexprs.tar.xz";

    # The shell's pnpm is the exact version CI uses (packageManager in package.json), so local
    # Turbo task hashes match CI's and the remote cache is shared. nixpkgs lags it, so it comes
    # from the npm registry's prebuilt package, locked by flake.lock. Renovate bumps these
    # version strings together with packageManager (.github/renovate.json), and the shell
    # fails to evaluate if they drift apart. pnpm itself downloads the Node.js that
    # devEngines.runtime pins, for every `pnpm run` and `pnpm exec`.
    pnpm-linux-x64 = {
      url = "https://registry.npmjs.org/@pnpm/exe.linux-x64/-/exe.linux-x64-12.21.0.tgz";
      flake = false;
    };
    pnpm-linux-arm64 = {
      url = "https://registry.npmjs.org/@pnpm/exe.linux-arm64/-/exe.linux-arm64-12.21.0.tgz";
      flake = false;
    };
  };

  outputs =
    { self, nixpkgs, nixpkgs-prisma5, ... }@inputs:
    let
      inherit (nixpkgs) lib;
      forAllSystems =
        f:
        lib.genAttrs [ "x86_64-linux" "aarch64-linux" ] (
          system: f nixpkgs.legacyPackages.${system} nixpkgs-prisma5.legacyPackages.${system}
        );
    in
    {
      packages = forAllSystems (pkgs: _: import ./nix/janet-packages.nix pkgs);
      checks = forAllSystems (
        pkgs: _:
        let
          packages = self.packages.${pkgs.stdenv.hostPlatform.system};
        in
        packages // { fold-retrieval = import ./nix/fold-retrieval-check.nix pkgs packages.fold-cards; }
      );

      devShells = forAllSystems (
        pkgs: pkgs-prisma5:
        let
          manifest = builtins.fromJSON (builtins.readFile ./package.json);
          src = inputs."pnpm-linux-${if pkgs.stdenv.hostPlatform.isAarch64 then "arm64" else "x64"}";
          pnpm = pkgs.stdenv.mkDerivation {
            pname = "pnpm";
            version = (builtins.fromJSON (builtins.readFile "${src}/package.json")).version;
            inherit src;
            nativeBuildInputs = [ pkgs.autoPatchelfHook ];
            buildInputs = [ pkgs.stdenv.cc.cc.lib ];
            dontStrip = true;
            installPhase = ''
              install -Dm755 pnpm $out/bin/pnpm
              ln -s pnpm $out/bin/pn
              ln -s pnpm $out/bin/pnpx
            '';
          };
          wantedPnpm = lib.removePrefix "pnpm@" manifest.packageManager;
          wantedNodeMajor = lib.versions.major manifest.devEngines.runtime.version;
          # Prisma has no engine downloads for NixOS, so it must be pointed at nixpkgs'
          # engines (https://wiki.nixos.org/wiki/Prisma), built from the exact Prisma
          # version that runs. PetalBoard and Slide pin different majors, and Slide's
          # Prisma 5 client aborts on Prisma 6's query engine, so the shell can't export
          # one set of paths. Instead a script preloaded into every Node process sets
          # them per version: first for the Prisma installed where the process starts,
          # then again for whichever Prisma package the process actually loads. A
          # version with no nixpkgs build gets no paths, so Prisma fails as it did before.
          engines = lib.listToAttrs (
            map (e: lib.nameValuePair e.version "${e}") [
              pkgs.prisma-engines_6
              pkgs-prisma5.prisma-engines
            ]
          );
          selectEngines = pkgs.writeText "prisma-engines.cjs" ''
            const fs = require("node:fs");
            const path = require("node:path");
            const { registerHooks } = require("node:module");
            const { fileURLToPath } = require("node:url");

            const engines = ${builtins.toJSON engines};
            const files = {
              PRISMA_SCHEMA_ENGINE_BINARY: "/bin/schema-engine",
              PRISMA_QUERY_ENGINE_BINARY: "/bin/query-engine",
              PRISMA_QUERY_ENGINE_LIBRARY: "/lib/libquery_engine.node",
              PRISMA_FMT_BINARY: "/bin/prisma-fmt",
            };

            // Set or clear all four, so a choice made for another version never leaks.
            function use(version) {
              const root = engines[version];
              for (const [name, file] of Object.entries(files)) {
                if (root === undefined) {
                  delete process.env[name];
                } else {
                  process.env[name] = root + file;
                }
              }
            }

            try {
              use(require(require.resolve("prisma/package.json", { paths: [process.cwd()] })).version);
            } catch {
              // No Prisma here (Prisma's postinstall runs from the repository root, for
              // one), so keep the parent process's choice.
            }

            // The innermost Prisma package of a path. (Not every @prisma/* package shares
            // Prisma's version: @prisma/engines-version doesn't.) The variables are global
            // to the process, so one process can use only one Prisma version's engines, and
            // a bundle that resolves no Prisma file keeps the working-directory choice.
            const prismaPackage = /^(.*[\\/]node_modules[\\/](?:prisma|@prisma[\\/](?:client|engines)))[\\/]/;
            const versions = new Map();
            registerHooks?.({
              resolve(specifier, context, nextResolve) {
                const result = nextResolve(specifier, context);
                const root = result.url.startsWith("file:")
                  ? prismaPackage.exec(fileURLToPath(result.url))?.[1]
                  : undefined;
                if (root !== undefined && !versions.has(root)) {
                  try {
                    const manifest = path.join(root, "package.json");
                    versions.set(root, JSON.parse(fs.readFileSync(manifest, "utf8")).version);
                  } catch {
                    // Not a package we can read; leave the choice alone.
                    versions.set(root, null);
                  }
                }
                const version = versions.get(root);
                if (version !== undefined && version !== null) {
                  use(version);
                }
                return result;
              },
            });
          '';
        in
        {
          default =
            assert lib.assertMsg (pnpm.version == wantedPnpm) ''
              flake.nix pins pnpm ${pnpm.version} but package.json packageManager wants ${wantedPnpm}.
              Update the two registry URLs in flake.nix inputs to match, then run `nix flake lock`.
            '';
            lib.warnIf (lib.versions.major pkgs.nodejs_26.version != wantedNodeMajor)
              "The shell's bare node is ${pkgs.nodejs_26.version}, but devEngines.runtime pins Node.js ${wantedNodeMajor}. pnpm still provisions the pinned one; point packages at the matching nodejs_NN."
              pkgs.mkShell {
            packages = [ pkgs.nodejs_26 pnpm ];
            shellHook = ''
              export NODE_OPTIONS="--require ${selectEngines}''${NODE_OPTIONS:+ $NODE_OPTIONS}"
            '';
          };
        }
      );
    };
}
