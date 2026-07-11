# NEEDS-REVIEW (dream2nix): written from memory of the dream2nix v1 module
# API without a local `nix build` to verify (no nix on this host). The crate
# itself is a completely normal cargo project — `cargo build --release` needs
# none of this. This flake only exists so forward deploys can come out of a
# Nix binary cache; rollback NEVER depends on it (rollback = local file swap,
# see RUNBOOK-canary-deploy.md).
#
# Things a reviewer should verify:
#   * module name: dream2nix.modules.dream2nix.rust-cargo-lock +
#     rust-crane are the documented Rust modules; confirm current names.
#   * Cargo.lock must be committed (dream2nix locks deps from it).
#   * If dream2nix churns again, the fallback below (plain
#     rustPlatform.buildRustPackage) is dependable and cache-friendly too —
#     swap `packages.default` to `packages.fallback` and move on.
{
  description = "agent-manager: supervisor for a persistent Claude Code agent session";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    dream2nix.url = "github:nix-community/dream2nix";
    dream2nix.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = { self, nixpkgs, dream2nix }:
    let
      forSystems = f: nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" ]
        (system: f system nixpkgs.legacyPackages.${system});
    in
    {
      packages = forSystems (system: pkgs: rec {
        default = dream2nix.lib.evalModules {
          packageSets.nixpkgs = pkgs;
          modules = [
            ./nix/agent-manager.nix
            {
              paths.projectRoot = ./.;
              paths.projectRootFile = "flake.nix";
              paths.package = ./.;
            }
          ];
        };

        # Verified-boring alternative if the dream2nix module bitrots.
        fallback = pkgs.rustPlatform.buildRustPackage {
          pname = "agent-manager";
          version = "0.1.0";
          src = pkgs.lib.cleanSource ./.;
          cargoLock.lockFile = ./Cargo.lock;
        };
      });
    };
}
