#!/bin/bash

# AgenFK Developer Sandbox Helper
# Simulates a real user installation in an isolated environment.

SANDBOX_HOME="/tmp/afk-sandbox"
API_PORT=3001
UI_PORT=5174

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

function usage() {
    echo "Usage: $0 [mount|unmount]"
    echo ""
    echo "Commands:"
    echo "  mount     Initialize sandbox and start services (Default)"
    echo "  unmount   Stop sandbox services and delete sandbox directory"
    exit 1
}

function mount_sandbox() {
    echo -e "${BLUE}=== Mounting AgenFK Developer Sandbox ===${NC}"
    
    mkdir -p "$SANDBOX_HOME"
    export HOME="$SANDBOX_HOME"
    export AGENFK_PORT=$API_PORT
    export VITE_PORT=$UI_PORT
    
    echo -e "${GREEN}Sandbox Home: $SANDBOX_HOME${NC}"
    echo -e "${GREEN}API Port:     $API_PORT${NC}"
    echo -e "${GREEN}UI Port:      $UI_PORT${NC}"

    if [ ! -f "$SANDBOX_HOME/.local/bin/agenfk" ]; then
        echo -e "${YELLOW}No installation found in sandbox. Running npx install...${NC}"
        npx github:cglab-PRIVATE/agenfk
    fi

    echo -e "${BLUE}Starting services...${NC}"
    "$SANDBOX_HOME/.local/bin/agenfk" up
    
    echo ""
    echo -e "${GREEN}Sandbox is ready!${NC}"
    echo -e "UI:  http://localhost:$UI_PORT"
    echo -e "API: http://localhost:$API_PORT"
    echo ""
    echo -e "${YELLOW}To use this sandbox in your current shell, run:${NC}"
    echo -e "export HOME=$SANDBOX_HOME"
    echo -e "export PATH=\"\$HOME/.local/bin:\$PATH\""
}

function unmount_sandbox() {
    echo -e "${BLUE}=== Unmounting AgenFK Developer Sandbox ===${NC}"
    
    echo -e "${YELLOW}Stopping services on ports $API_PORT and $UI_PORT...${NC}"
    fuser -k $API_PORT/tcp 2>/dev/null
    fuser -k $UI_PORT/tcp 2>/dev/null
    
    # Also stop any node processes running from the sandbox directory just in case
    pkill -f "$SANDBOX_HOME"
    
    echo -e "${RED}Deleting sandbox directory: $SANDBOX_HOME${NC}"
    rm -rf "$SANDBOX_HOME"
    
    echo -e "${GREEN}Sandbox unmounted successfully.${NC}"
}

case "$1" in
    mount|"")
        mount_sandbox
        ;;
    unmount)
        unmount_sandbox
        ;;
    *)
        usage
        ;;
esac
