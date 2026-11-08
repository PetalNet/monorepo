{
  description = "PetalNet monorepo dev shell";

  inputs.nixpkgs.url = "https://channels.nixos.org/nixos-unstable/nixexprs.tar.zst";

  outputs =
    { nixpkgs, ... }:
    let
      inherit (nixpkgs) lib;
      forAllSystems =
        f: lib.genAttrs lib.systems.flakeExposed (system: f nixpkgs.legacyPackages.${system});
      lockfile = builtins.readFile ./pnpm-lock.yaml;
    in
    {
      devShells = forAllSystems (pkgs: {
        # Prisma can't download its engines on NixOS (there is no linux-nixos build),
        # so the shell supplies nixpkgs' engines, per https://wiki.nixos.org/wiki/Prisma.
        # The setup hook of prisma-engines exports PRISMA_SCHEMA_ENGINE_BINARY,
        # PRISMA_QUERY_ENGINE_BINARY, PRISMA_QUERY_ENGINE_LIBRARY and PRISMA_FMT_BINARY.
        # The engines must match PetalBoard's Prisma (the prisma6 catalog). Slide is on
        # Prisma 5, which nixpkgs no longer packages, so it runs against these engines too.
        default =
          let
            engines = pkgs.prisma-engines_6;
          in
          lib.warnIfNot (lib.hasInfix "'@prisma/engines@${engines.version}':" lockfile)
            "prisma-engines ${engines.version} from nixpkgs is not in pnpm-lock.yaml; update the flake's nixpkgs or Prisma so they match"
            (pkgs.mkShell { packages = [ engines ]; });
      });
    };
}
