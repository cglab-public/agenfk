#!/bin/bash
# AgenFK Framework Uninstaller — Bash Wrapper
# Delegates to the Node.js implementation for cross-platform consistency.

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

# Ensure node is available
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is required to uninstall AgenFK."
    exit 1
fi

# Run the Node.js uninstaller
node scripts/uninstall.mjs "$@"
