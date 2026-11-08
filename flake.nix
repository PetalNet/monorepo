{
  description = "PetalNet monorepo dev shell";

  inputs = {
    nixpkgs.url = "https://channels.nixos.org/nixos-unstable/nixexprs.tar.zst";
    # The last release that packages Prisma 5 engines (5.22.0), which Slide pins.
    nixpkgs-prisma5.url = "https://channels.nixos.org/nixos-24.11/nixexprs.tar.xz";
  };

  outputs =
    { nixpkgs, nixpkgs-prisma5, ... }:
    let
      inherit (nixpkgs) lib;
      forAllSystems =
        f:
        lib.genAttrs [ "x86_64-linux" "aarch64-linux" ] (
          system: f nixpkgs.legacyPackages.${system} nixpkgs-prisma5.legacyPackages.${system}
        );
    in
    {
      devShells = forAllSystems (
        pkgs: pkgs-prisma5:
        let
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
            // Prisma's version: @prisma/engines-version doesn't.)
            const prismaPackage = /^(.*[\\/]node_modules[\\/](?:prisma|@prisma[\\/](?:client|engines)))[\\/]/;
            const versions = new Map();
            registerHooks?.({
              resolve(specifier, context, nextResolve) {
                const result = nextResolve(specifier, context);
                const root = result.url.startsWith("file:")
                  ? prismaPackage.exec(fileURLToPath(result.url))?.[1]
                  : undefined;
                if (root !== undefined) {
                  if (!versions.has(root)) {
                    const manifest = path.join(root, "package.json");
                    versions.set(root, JSON.parse(fs.readFileSync(manifest, "utf8")).version);
                  }
                  use(versions.get(root));
                }
                return result;
              },
            });
          '';
        in
        {
          default = pkgs.mkShell {
            shellHook = ''
              export NODE_OPTIONS="--require ${selectEngines}''${NODE_OPTIONS:+ $NODE_OPTIONS}"
            '';
          };
        }
      );
    };
}
