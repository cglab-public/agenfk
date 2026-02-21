#!/bin/bash
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

SKIP_CONFIRM=false
if [[ "$1" == "-y" || "$1" == "--yes" ]]; then
    SKIP_CONFIRM=true
fi

echo -e "${BLUE}=== AgenFK Uninstaller ===${NC}"
echo ""
echo -e "${YELLOW}This will remove:${NC}"
echo "  - Slash commands from Claude Code and Opencode"
echo "  - Opencode skill"
echo "  - MCP server config from Claude Code and Opencode"
echo "  - ~/.agenfk-system (the framework files)"
echo ""
if [ "$SKIP_CONFIRM" = false ]; then
    read -r -p "Are you sure? [y/N] " confirm
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
        echo "Aborted."
        exit 0
    fi
fi

echo ""

# 1. Slash commands — Claude Code
echo -e "${GREEN}[1/5] Removing Claude Code slash commands...${NC}"
for f in "$HOME/.claude/commands/agenfk"*.md; do
    [ -f "$f" ] && rm "$f" && echo "  Removed: $f"
done

# 2. Slash commands — Opencode
echo -e "${GREEN}[2/5] Removing Opencode slash commands...${NC}"
for f in "$HOME/.config/opencode/commands/agenfk"*.md; do
    [ -f "$f" ] && rm "$f" && echo "  Removed: $f"
done

# 3. Opencode skill
echo -e "${GREEN}[3/5] Removing Opencode skill...${NC}"
SKILL_DIR="$HOME/.config/opencode/skills/agenfk"
if [ -d "$SKILL_DIR" ]; then
    rm -rf "$SKILL_DIR"
    echo "  Removed: $SKILL_DIR"
fi

# 4. CLI symlink
echo -e "${GREEN}[4/6] Removing agenfk CLI symlink...${NC}"
if [ -L "$HOME/.local/bin/agenfk" ]; then
    rm "$HOME/.local/bin/agenfk"
    echo "  Removed: $HOME/.local/bin/agenfk"
fi

# 5. MCP config — Claude Code
echo -e "${GREEN}[5/6] Removing Claude Code MCP config...${NC}"
if command -v claude &> /dev/null; then
    claude mcp remove agenfk 2>/dev/null && echo "  Removed: agenfk MCP from Claude Code" || echo "  Not found in Claude Code (skipping)"
else
    echo "  Claude Code CLI not found (skipping)"
fi

# 6. MCP config — Opencode
echo -e "${GREEN}[6/6] Removing Opencode MCP config...${NC}"
OPENCODE_CONFIG="$HOME/.config/opencode/opencode.json"
if [ -f "$OPENCODE_CONFIG" ]; then
    node -e "
    const fs = require('fs');
    const config = JSON.parse(fs.readFileSync('$OPENCODE_CONFIG', 'utf8'));
    if (config.mcp && config.mcp.agenfk) {
        delete config.mcp.agenfk;
        fs.writeFileSync('$OPENCODE_CONFIG', JSON.stringify(config, null, 2));
        console.log('  Removed: agenfk MCP from opencode.json');
    } else {
        console.log('  Not found in opencode.json (skipping)');
    }
    "
else
    echo "  Opencode config not found (skipping)"
fi

echo ""
echo -e "${RED}Removing ~/.agenfk-system...${NC}"
if [ -d "$HOME/.agenfk-system" ]; then
    rm -rf "$HOME/.agenfk-system"
    echo "  Removed: $HOME/.agenfk-system"
else
    echo "  Not found (skipping)"
fi

echo ""
echo -e "${GREEN}AgenFK uninstalled successfully.${NC}"
echo "Restart your AI editor to complete the removal."
