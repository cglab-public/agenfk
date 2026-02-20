#!/bin/bash
set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

echo -e "${BLUE}=== Agentic Framework Integration ===${NC}"

# 1. Build the project
echo -e "${GREEN}[1/6] Building project...${NC}"
npm install
npm run build

# 2. Ensure configuration exists
echo -e "${GREEN}[2/6] Initializing configuration...${NC}"
if [ ! -d ".agentic" ]; then
    node packages/cli/bin/agenfk.js init
fi

# 3. Create start script for UI/API
echo -e "${GREEN}[3/6] Creating background service script (start-services.sh)...${NC}"
DB_PATH="$(pwd)/.agentic/db.json"
cat > start-services.sh << EOF
#!/bin/bash
# Kill background jobs on exit
trap "exit" INT TERM
trap "kill 0" EXIT

echo "Starting API Server on port 3000..."
export AGENTIC_DB_PATH="$DB_PATH"
node packages/server/dist/server.js > .agentic/api.log 2>&1 &
API_PID=\$!

echo "Starting UI on port 5173..."
cd packages/ui && npm run dev > ../../.agentic/ui.log 2>&1 &
UI_PID=\$!

echo "Services started."
echo "API: http://localhost:3000"
echo "UI:  http://localhost:5173"
echo "Database: \$AGENTIC_DB_PATH"
echo "Logs are in .agentic/*.log"
echo "Press Ctrl+C to stop both services."

wait
EOF
chmod +x start-services.sh

# 4. Configure Opencode MCP
echo -e "${GREEN}[4/6] Configuring Opencode MCP...${NC}"
SERVER_PATH="$(pwd)/packages/server/dist/index.js"
DB_PATH="$(pwd)/.agentic/db.json"
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
        
        config.mcp.agentic = {
            type: 'local',
            enabled: true,
            command: ['node', serverPath],
            environment: { 
                NODE_ENV: 'production',
                AGENTIC_DB_PATH: dbPath
            }
        };
        
        fs.writeFileSync(path, JSON.stringify(config, null, 2));
        console.log('Successfully updated opencode.json with agentic MCP server and absolute DB path.');
    } catch (e) {
        console.error('Error updating opencode.json:', e);
        process.exit(1);
    }
    "
else
    echo -e "${BLUE}Opencode config not found at $OPENCODE_CONFIG. Skipping auto-configuration.${NC}"
fi

# 5. Install Agentic Skills
echo -e "${GREEN}[5/6] Installing agenfk skills...${NC}"
SKILLS_DIR="$HOME/.config/opencode/skills/agenfk"
mkdir -p "$SKILLS_DIR"
if [ -f "$DIR/SKILL.md" ]; then
    cp "$DIR/SKILL.md" "$SKILLS_DIR/SKILL.md"
    echo -e "Successfully installed agenfk skills to $SKILLS_DIR/SKILL.md"
else
    echo -e "${BLUE}SKILL.md not found in $DIR. Skipping skills installation.${NC}"
fi

# 6. Enforce Skill Usage (The "Pre-select" Hook)
echo -e "${GREEN}[6/6] Enforcing agenfk skill for this project...${NC}"
mkdir -p "$DIR/.opencode"
cat > "$DIR/.opencode/instructions.md" << EOF
# Project-Specific Workflow Enforcement (agenfk)
This project is configured with the 'agenfk' engineering workflow.

## MANDATORY INSTRUCTIONS:
1. For ANY engineering task (implementing features, fixing bugs, refactoring), you MUST call the 'skill' tool with name 'agenfk' immediately after the "Understand" phase.
2. You MUST use the 'agentic_workflow_gatekeeper' tool BEFORE making any file modifications (write/edit).
3. Strictly follow the instructions provided by the 'agenfk' skill once loaded.
4. Your goal is to ensure every change is tracked and validated against the Agentic database.
EOF

echo -e "Successfully created project-level instructions in $DIR/.opencode/instructions.md"

echo -e "${GREEN}Integration Complete.${NC}"
echo ""
echo -e "${BLUE}=== Manual Configuration (for Cursor/Claude) ===${NC}"
echo "If you are using Cursor or Claude Desktop, add this to your configuration:"
echo ""
cat << EOF
{
  "mcpServers": {
    "agentic": {
      "command": "node",
      "args": ["$SERVER_PATH"],
      "env": {
        "NODE_ENV": "production"
      }
    }
  }
}
EOF
echo ""
echo -e "${BLUE}=== Usage Instructions ===${NC}"
echo "1. Restart your AI editor/agent (Opencode needs a restart to pick up the new MCP)."
echo "2. Run './start-services.sh' in a separate terminal to enable the Web UI."
echo "3. Ask the AI: 'Create a task to refactor the login page using the Agentic framework'."
