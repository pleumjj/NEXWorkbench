#!/bin/bash
# macOS: double-click in Finder to start NEX Workbench (installs and builds the first time).
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Get the LTS from https://nodejs.org, then double-click this file again."
  read -r -p "Press Enter to close…"; exit 1
fi
node scripts/launch.mjs
