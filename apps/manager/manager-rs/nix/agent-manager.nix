# dream2nix package module for agent-manager.
# 2026-07-03: build-verified against dream2nix dd8a3ebb / nixpkgs 2026-07-02.
# rust-crane requires rust-cargo-vendor as a sibling import (it reads
# config.rust-cargo-vendor.{vendoredSources,writeGitVendorEntries,...}); the
# first draft omitted it → "attribute 'rust-cargo-vendor' missing" at eval.
{ config, lib, dream2nix, ... }: {
  imports = [
    dream2nix.modules.dream2nix.rust-cargo-lock
    dream2nix.modules.dream2nix.rust-cargo-vendor
    dream2nix.modules.dream2nix.rust-crane
  ];

  name = "agent-manager";
  version = "0.1.0";

  deps = { nixpkgs, ... }: {
    inherit (nixpkgs) stdenv;
  };

  mkDerivation = {
    src = lib.cleanSource ../.;
  };
}
