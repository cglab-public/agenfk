#!/bin/bash
set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

echo -e "${BLUE}=== AgenFK Framework Installation ===${NC}"

# 1. Build the project
echo -e "${GREEN}[1/8] Building project...${NC}"
npm install
npm run build

# 2. Ensure configuration exists
echo -e "${GREEN}[2/8] Initializing configuration...${NC}"
if [ ! -d ".agenfk" ]; then
    node packages/cli/bin/agenfk.js init
fi

# 3. Create start script for UI/API
echo -e "${GREEN}[3/9] Creating background service script (start-services.sh)...${NC}"
AGENFK_ROOT="$(pwd)"
DB_PATH="${AGENFK_ROOT}/.agenfk/db.json"
cat > start-services.sh << INNEREOF
#!/bin/bash
# AgenFK service launcher — all paths are absolute so this works from anywhere
AGENFK_ROOT="${AGENFK_ROOT}"

trap "exit" INT TERM
trap "kill 0" EXIT

mkdir -p "\${AGENFK_ROOT}/.agenfk"

echo "Starting API Server on port 3000..."
export AGENFK_DB_PATH="${DB_PATH}"
node "\${AGENFK_ROOT}/packages/server/dist/server.js" > "\${AGENFK_ROOT}/.agenfk/api.log" 2>&1 &

echo "Starting UI..."
cd "\${AGENFK_ROOT}/packages/ui" && npm run dev > "\${AGENFK_ROOT}/.agenfk/ui.log" 2>&1 &

echo "Services started."
echo "API: http://localhost:3000"
echo "Database: \${AGENFK_DB_PATH}"
echo "Logs: \${AGENFK_ROOT}/.agenfk/*.log"
echo "Press Ctrl+C to stop both services."

echo "Waiting for UI to be ready..."
UI_URL=""
for i in {1..15}; do
    if grep -q "http://localhost:" "\${AGENFK_ROOT}/.agenfk/ui.log" 2>/dev/null; then
        UI_URL=\$(grep -o 'http://localhost:[0-9]*' "\${AGENFK_ROOT}/.agenfk/ui.log" | head -n 1)
        break
    fi
    sleep 1
done

if [ -z "\$UI_URL" ]; then
    UI_URL="http://localhost:5173"
fi

echo "UI available at: \$UI_URL"

if grep -qEi "(Microsoft|WSL)" /proc/version &> /dev/null; then
    explorer.exe "\$UI_URL" > /dev/null 2>&1 || true
elif [[ "\$OSTYPE" == "linux-gnu"* ]]; then
    xdg-open "\$UI_URL" > /dev/null 2>&1 || true
elif [[ "\$OSTYPE" == "darwin"* ]]; then
    open "\$UI_URL" > /dev/null 2>&1 || true
fi

wait
INNEREOF
chmod +x start-services.sh

SERVER_PATH="$(pwd)/packages/server/dist/index.js"

# 4. Configure Opencode MCP
echo -e "${GREEN}[4/8] Configuring Opencode MCP...${NC}"
OPENCODE_CONFIG="$HOME/.config/opencode/opencode.json"
if [ -f "$OPENCODE_CONFIG" ]; then
    node -e "
    const fs = require('fs');
    const path = '$OPENCODE_CONFIG';
    const serverPath = '$SERVER_PATH';
    const dbPath = '$DB_PATH';
    
    try {
        const config = JSON.parse(fs.readFileSync(path, 'utf8'));
        if (!config.mcp) config.mcp = {};
        
        config.mcp.agenfk = {
            type: 'local',
            enabled: true,
            command: ['node', serverPath],
            environment: { 
                NODE_ENV: 'production',
                AGENFK_DB_PATH: dbPath
            }
        };
        
        fs.writeFileSync(path, JSON.stringify(config, null, 2));
        console.log('Successfully updated opencode.json with agenfk MCP server and absolute DB path.');
    } catch (e) {
        console.error('Error updating opencode.json:', e);
        process.exit(1);
    }
    "
else
    echo -e "${BLUE}Opencode config not found at $OPENCODE_CONFIG. Skipping auto-configuration.${NC}"
fi

# 5. Configure Claude Code MCP
echo -e "${GREEN}[5/8] Configuring Claude Code MCP...${NC}"
if command -v claude &> /dev/null; then
    echo "Adding AgenFK MCP Server to Claude Code..."
    claude mcp add agenfk env AGENFK_DB_PATH="$DB_PATH" node "$SERVER_PATH" || echo "MCP server already configured in Claude."
else
    echo -e "${BLUE}Claude Code CLI not found. Skipping Claude MCP configuration.${NC}"
fi

# 6. Install AgenFK Skills
echo -e "${GREEN}[6/8] Installing agenfk skills (Opencode)...${NC}"
SKILLS_DIR="$HOME/.config/opencode/skills/agenfk"
mkdir -p "$SKILLS_DIR"
if [ -f "$DIR/SKILL.md" ]; then
    cp "$DIR/SKILL.md" "$SKILLS_DIR/SKILL.md"
    echo -e "Successfully installed agenfk skills to $SKILLS_DIR/SKILL.md"
else
    echo -e "${BLUE}SKILL.md not found in $DIR. Skipping skills installation.${NC}"
fi

# 7. Symlink CLI to ~/.local/bin
echo -e "${GREEN}[7/9] Installing agenfk command to ~/.local/bin...${NC}"
mkdir -p "$HOME/.local/bin"
ln -sf "$DIR/packages/cli/bin/agenfk.js" "$HOME/.local/bin/agenfk"
chmod +x "$DIR/packages/cli/bin/agenfk.js"
echo -e "  Symlinked: $HOME/.local/bin/agenfk -> $DIR/packages/cli/bin/agenfk.js"
if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
    echo -e "${YELLOW}  Note: Add ~/.local/bin to your PATH if not already present:${NC}"
    echo -e "    echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc"
fi

# 8. Install Global Slash Commands (Opencode)
echo -e "${GREEN}[8/9] Installing global slash commands (Opencode)...${NC}"
OC_COMMANDS_DIR="$HOME/.config/opencode/commands"
mkdir -p "$OC_COMMANDS_DIR"
for cmd_file in "$DIR/commands/"*.md; do
    cp "$cmd_file" "$OC_COMMANDS_DIR/$(basename "$cmd_file")"
    echo -e "  Installed: $OC_COMMANDS_DIR/$(basename "$cmd_file")"
done

# 9. Install Global Slash Commands (Claude Code)
echo -e "${GREEN}[9/9] Installing global slash commands (Claude Code)...${NC}"
CL_COMMANDS_DIR="$HOME/.claude/commands"
mkdir -p "$CL_COMMANDS_DIR"
for cmd_file in "$DIR/commands/"*.md; do
    cp "$cmd_file" "$CL_COMMANDS_DIR/$(basename "$cmd_file")"
    echo -e "  Installed: $CL_COMMANDS_DIR/$(basename "$cmd_file")"
done

echo -e "${GREEN}Installation Complete.${NC}"
echo ""
echo -e "${BLUE}=== Usage Instructions ===${NC}"
echo "1. Restart your AI editor/agent (Opencode needs a restart to pick up the new MCP)."
echo "2. Run 'agenfk up' in a separate terminal to start the API and Web UI."
echo "3. Go to ANY project repository and type '/agenfk' in your AI editor's prompt to initialize your project context and start the workflow."
echo "4. Use '/agenfk-push' to push to remote and optionally cut a GitHub release."
echo "5. Run 'agenfk health' to verify your installation at any time."
