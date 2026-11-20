"""Synthetic protocol peer. Production uses vault-scan, never this fixture."""
import sys

text = sys.stdin.read()
sys.exit(1 if 'fixture-secret' in text else 0)
