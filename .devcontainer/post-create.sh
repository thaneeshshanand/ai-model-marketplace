#!/usr/bin/env bash
# Phase 0 container bootstrap.
# Runs once when the Codespace is first created.
# Each block is tolerant of failure so a single miss does not abort the build.

set -uo pipefail

echo "=============================================="
echo " 1/4  Installing Node dependencies"
echo "=============================================="
npm install || {
  echo "npm install failed. Capture the error above and report it."
}

echo "=============================================="
echo " 2/4  Installing Slither and solc-select"
echo "=============================================="
# Three fallbacks: standard, user-local, then PEP 668 override.
python3 -m pip install --upgrade pip 2>/dev/null || true
python3 -m pip install slither-analyzer solc-select \
  || python3 -m pip install --user slither-analyzer solc-select \
  || python3 -m pip install --break-system-packages slither-analyzer solc-select \
  || echo "Slither install failed. Not fatal for Phase 0. Report the error."

echo "=============================================="
echo " 3/4  Pinning solc 0.8.24"
echo "=============================================="
# Slither normally compiles via Hardhat, so this is a backup path only.
solc-select install 0.8.24 2>/dev/null || true
solc-select use 0.8.24 2>/dev/null || true

echo "=============================================="
echo " 4/4  Compiling contracts"
echo "=============================================="
npx hardhat compile || echo "Compile failed. Report the error."

echo ""
echo "Bootstrap finished. Versions detected:"
echo "  node    : $(node -v 2>/dev/null || echo MISSING)"
echo "  npm     : $(npm -v 2>/dev/null || echo MISSING)"
echo "  python  : $(python3 -V 2>/dev/null || echo MISSING)"
echo "  slither : $(slither --version 2>/dev/null || echo MISSING)"
echo "  solc    : $(solc --version 2>/dev/null | tail -1 || echo MISSING)"
echo ""
echo "Next: npm run verify"
