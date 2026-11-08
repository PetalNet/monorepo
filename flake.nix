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
          # engines (https://wiki.nixos.org/wiki/Prisma), and those must be the build of
          # the exact Prisma version that runs. PetalBoard and Slide pin different majors,
          # so one set of exported paths can't serve both: Slide's Prisma 5 client aborts
          # on PetalBoard's Prisma 6 query engine. Instead every Node process in the shell
          # picks the engines for the Prisma installed where it runs, and leaves Prisma
          # alone (it fails as before) when no nixpkgs build matches.
          engines = lib.listToAttrs (
            map (e: lib.nameValuePair e.version "${e}") [
              pkgs.prisma-engines_6
              pkgs-prisma5.prisma-engines
            ]
          );
          selectEngines = pkgs.writeText "prisma-engines.cjs" ''
            const engines = ${builtins.toJSON engines};
            let version;
            try {
              const manifest = require.resolve("prisma/package.json", { paths: [process.cwd()] });
              version = require(manifest).version;
            } catch {
              // No Prisma here (Prisma's postinstall runs its CLI from the repository
              // root, for one), so keep whatever the parent process chose.
              return;
            }
            const dir = engines[version];
            const files = {
              PRISMA_SCHEMA_ENGINE_BINARY: "/bin/schema-engine",
              PRISMA_QUERY_ENGINE_BINARY: "/bin/query-engine",
              PRISMA_QUERY_ENGINE_LIBRARY: "/lib/libquery_engine.node",
              PRISMA_FMT_BINARY: "/bin/prisma-fmt",
            };
            // Set or clear all four, so a parent's choice for another version never leaks.
            for (const [name, file] of Object.entries(files)) {
              if (dir === undefined) {
                delete process.env[name];
              } else {
                process.env[name] = dir + file;
              }
            }
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
