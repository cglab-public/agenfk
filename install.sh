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
echo -e "${GREEN}[3/8] Creating background service script (start-services.sh)...${NC}"
DB_PATH="$(pwd)/.agenfk/db.json"
cat > start-services.sh << INNEREOF
#!/bin/bash
# Kill background jobs on exit
trap "exit" INT TERM
trap "kill 0" EXIT

echo "Starting API Server on port 3000..."
export AGENFK_DB_PATH="\$DB_PATH"
node packages/server/dist/server.js > .agenfk/api.log 2>&1 &
API_PID=\$!

echo "Starting UI on port 5173..."
cd packages/ui && npm run dev > ../../.agenfk/ui.log 2>&1 &
UI_PID=\$!

echo "Services started."
echo "API: http://localhost:3000"
echo "UI:  http://localhost:5173"
echo "Database: \$AGENFK_DB_PATH"
echo "Logs are in .agenfk/*.log"
echo "Press Ctrl+C to stop both services."

# Wait a moment for UI server to boot
sleep 2

# Attempt to open browser
if grep -qEi "(Microsoft|WSL)" /proc/version &> /dev/null; then
    explorer.exe "http://localhost:5173" > /dev/null 2>&1 || true
elif [[ "\$OSTYPE" == "linux-gnu"* ]]; then
    xdg-open "http://localhost:5173" > /dev/null 2>&1 || true
elif [[ "\$OSTYPE" == "darwin"* ]]; then
    open "http://localhost:5173" > /dev/null 2>&1 || true
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

# 7. Create Global Slash Command (Opencode)
echo -e "${GREEN}[7/8] Installing global /agenfk slash command (Opencode)...${NC}"
OC_COMMANDS_DIR="$HOME/.config/opencode/commands"
mkdir -p "$OC_COMMANDS_DIR"
cat > "$OC_COMMANDS_DIR/agenfk.md" << INNEREOF
---
description: Initialize and load the AgenFK Engineering Framework for this project
---

Load the \`agenfk\` skill. Run its Initialization protocol. If this is a new project, scan the codebase and create the required markdown files (AFK_PROJECT_SCOPE.md and AFK_ARCHITECTURE.md). Always associate my requests with the current active project.
INNEREOF
echo -e "Successfully installed slash command to $OC_COMMANDS_DIR/agenfk.md"

# 8. Create Global Slash Command (Claude Code)
echo -e "${GREEN}[8/8] Installing global /agenfk slash command (Claude Code)...${NC}"
CL_COMMANDS_DIR="$HOME/.claude/commands"
mkdir -p "$CL_COMMANDS_DIR"
cat > "$CL_COMMANDS_DIR/agenfk.md" << INNEREOF
---
description: Initialize and load the AgenFK Engineering Framework for this project
---

Load the \`agenfk\` skill. Run its Initialization protocol. If this is a new project, scan the codebase and create the required markdown files (AFK_PROJECT_SCOPE.md and AFK_ARCHITECTURE.md). Always associate my requests with the current active project.
INNEREOF
echo -e "Successfully installed slash command to $CL_COMMANDS_DIR/agenfk.md"

echo -e "${GREEN}Installation Complete.${NC}"
echo ""
echo -e "${BLUE}=== Usage Instructions ===${NC}"
echo "1. Restart your AI editor/agent (Opencode needs a restart to pick up the new MCP)."
echo "2. Run './start-services.sh' in a separate terminal to enable the Web UI."
echo "3. Go to ANY project repository and type '/agenfk' in your AI editor's prompt to initialize your project context and start the workflow."
