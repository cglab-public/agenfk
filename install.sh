#!/bin/bash
set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

echo -e "${BLUE}=== AgenFK Framework Installation ===${NC}"

# 1. Build the project
echo -e "${GREEN}[1/12] Building project...${NC}"
npm install
npm run build

# 2. Generate install-time secret verify token
echo -e "${GREEN}[2/12] Generating secret verify token...${NC}"
mkdir -p "$HOME/.agenfk"
node -e "
const crypto = require('crypto');
const fs = require('fs');
const tokenPath = require('os').homedir() + '/.agenfk/verify-token';
fs.writeFileSync(tokenPath, crypto.randomBytes(32).toString('hex'), 'utf8');
fs.chmodSync(tokenPath, 0o600);
console.log('  Generated: ' + tokenPath);
"

# 3. Ensure configuration exists
echo -e "${GREEN}[3/12] Initializing configuration...${NC}"
if [ ! -d ".agenfk" ]; then
    node packages/cli/bin/agenfk.js init
fi

# 4. Create start script for UI/API
echo -e "${GREEN}[4/12] Creating background service script (start-services.sh)...${NC}"
AGENFK_ROOT="$(pwd)"
DB_PATH="${AGENFK_ROOT}/.agenfk/db.json"
cat > start-services.sh << INNEREOF
#!/bin/bash
# AgenFK service launcher — all paths are absolute so this works from anywhere
AGENFK_ROOT="${AGENFK_ROOT}"

trap "exit" INT TERM
trap "kill 0" EXIT

mkdir -p "\${AGENFK_ROOT}/.agenfk"

echo "Clearing port 3000..."
fuser -k 3000/tcp > /dev/null 2>&1 || true
sleep 0.5

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

# 5. Configure Opencode MCP
echo -e "${GREEN}[5/12] Configuring Opencode MCP...${NC}"
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
echo -e "${GREEN}[5/12] Configuring Claude Code MCP...${NC}"
if command -v claude &> /dev/null; then
    echo "Adding AgenFK MCP Server to Claude Code..."
    claude mcp add agenfk env AGENFK_DB_PATH="$DB_PATH" node "$SERVER_PATH" || echo "MCP server already configured in Claude."
else
    echo -e "${BLUE}Claude Code CLI not found. Skipping Claude MCP configuration.${NC}"
fi

# 6. Install AgenFK Skills
echo -e "${GREEN}[6/12] Installing agenfk skills (Opencode)...${NC}"
SKILLS_DIR="$HOME/.config/opencode/skills/agenfk"
mkdir -p "$SKILLS_DIR"
if [ -f "$DIR/SKILL.md" ]; then
    rm -f "$SKILLS_DIR/SKILL.md"
    cp "$DIR/SKILL.md" "$SKILLS_DIR/SKILL.md"
    echo -e "Successfully installed agenfk skills to $SKILLS_DIR/SKILL.md"
else
    echo -e "${BLUE}SKILL.md not found in $DIR. Skipping skills installation.${NC}"
fi

# 7. Symlink CLI to ~/.local/bin
echo -e "${GREEN}[7/12] Installing agenfk command to ~/.local/bin...${NC}"
mkdir -p "$HOME/.local/bin"
ln -sf "$DIR/packages/cli/bin/agenfk.js" "$HOME/.local/bin/agenfk"
chmod +x "$DIR/packages/cli/bin/agenfk.js"
echo -e "  Symlinked: $HOME/.local/bin/agenfk -> $DIR/packages/cli/bin/agenfk.js"
if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
    echo -e "${YELLOW}  Note: Add ~/.local/bin to your PATH if not already present:${NC}"
    echo -e "    echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc"
fi

# 8. Install Global Slash Commands (Opencode)
echo -e "${GREEN}[8/12] Installing global slash commands (Opencode)...${NC}"
OC_COMMANDS_DIR="$HOME/.config/opencode/commands"
mkdir -p "$OC_COMMANDS_DIR"
rm -f "$OC_COMMANDS_DIR/agenfk-push.md"
for cmd_file in "$DIR/commands/"*.md; do
    rm -f "$OC_COMMANDS_DIR/$(basename "$cmd_file")"
    cp "$cmd_file" "$OC_COMMANDS_DIR/$(basename "$cmd_file")"
    echo -e "  Installed: $OC_COMMANDS_DIR/$(basename "$cmd_file")"
done

# 9. Install Global Slash Commands (Claude Code)
echo -e "${GREEN}[9/12] Installing global slash commands (Claude Code)...${NC}"
CL_COMMANDS_DIR="$HOME/.claude/commands"
mkdir -p "$CL_COMMANDS_DIR"
rm -f "$CL_COMMANDS_DIR/agenfk-push.md"
for cmd_file in "$DIR/commands/"*.md; do
    rm -f "$CL_COMMANDS_DIR/$(basename "$cmd_file")"
    cp "$cmd_file" "$CL_COMMANDS_DIR/$(basename "$cmd_file")"
    echo -e "  Installed: $CL_COMMANDS_DIR/$(basename "$cmd_file")"
done

# 10. Install gatekeeper hook script
echo -e "${GREEN}[10/12] Installing agenfk-gatekeeper hook script...${NC}"
cp "$DIR/bin/agenfk-gatekeeper.sh" "$HOME/.local/bin/agenfk-gatekeeper"
chmod +x "$HOME/.local/bin/agenfk-gatekeeper"
echo -e "  Installed: $HOME/.local/bin/agenfk-gatekeeper"

# 11. Write AgenFK workflow rules to ~/.claude/CLAUDE.md
echo -e "${GREEN}[11/12] Writing AgenFK workflow rules to ~/.claude/CLAUDE.md...${NC}"
CLAUDE_MD="$HOME/.claude/CLAUDE.md"
mkdir -p "$HOME/.claude"
# Remove any previous agenfk block
if [ -f "$CLAUDE_MD" ]; then
    node -e "
    const fs = require('fs');
    let content = fs.readFileSync('$CLAUDE_MD', 'utf8');
    content = content.replace(/\n?<!-- agenfk:start -->[\s\S]*?<!-- agenfk:end -->\n?/g, '');
    fs.writeFileSync('$CLAUDE_MD', content);
    "
fi
cat >> "$CLAUDE_MD" << 'AGENFK_RULES'

<!-- agenfk:start -->
## AgenFK Workflow — MANDATORY

Before modifying ANY file (Edit, Write, NotebookEdit), you MUST:
1. Have an AgenFK task set to `IN_PROGRESS` for the active project.
2. Call `workflow_gatekeeper(intent)` via MCP to confirm authorization.

If no task is `IN_PROGRESS`, stop and do this first — using MCP tools:
- `create_item(projectId, "TASK", "<title>")`
- `update_item(id, {status: "IN_PROGRESS"})`

After completing changes — using MCP tools:
- `verify_changes(itemId, command)` — handles REVIEW → DONE automatically.
- `log_token_usage(itemId, input, output, model)`.

**ALWAYS use MCP tools for workflow state changes. NEVER use the `agenfk` CLI
to create items, update status, or close tasks — the CLI bypasses enforcement.**

A PreToolUse hook enforces the IN_PROGRESS check mechanically.
<!-- agenfk:end -->
AGENFK_RULES
echo -e "  Written: $CLAUDE_MD"

# 12. Register PreToolUse hook in ~/.claude/settings.json
echo -e "${GREEN}[12/12] Registering PreToolUse hook in ~/.claude/settings.json...${NC}"
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
GATEKEEPER_PATH="$HOME/.local/bin/agenfk-gatekeeper"
node -e "
const fs = require('fs');
const os = require('os');
const settingsPath = '$CLAUDE_SETTINGS';
const gatekeeperPath = '$GATEKEEPER_PATH';

let config = {};
if (fs.existsSync(settingsPath)) {
    try { config = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch(e) {}
}

if (!config.hooks) config.hooks = {};
if (!config.hooks.PreToolUse) config.hooks.PreToolUse = [];

// Remove any existing agenfk gatekeeper entry
config.hooks.PreToolUse = config.hooks.PreToolUse.filter(entry =>
    !JSON.stringify(entry).includes('agenfk-gatekeeper')
);

// Add the gatekeeper hook
config.hooks.PreToolUse.push({
    matcher: 'Edit|Write|NotebookEdit',
    hooks: [{ type: 'command', command: gatekeeperPath }]
});

fs.writeFileSync(settingsPath, JSON.stringify(config, null, 2));
console.log('  Registered PreToolUse hook in ' + settingsPath);
"

echo -e "${GREEN}Installation Complete.${NC}"
echo ""
echo -e "${BLUE}=== Usage Instructions ===${NC}"
echo "1. Restart your AI editor/agent (Opencode needs a restart to pick up the new MCP)."
echo "2. Run 'agenfk up' in a separate terminal to start the API and Web UI."
echo "3. Go to ANY project repository and type '/agenfk' in your AI editor's prompt to initialize your project context and start the workflow."
echo "4. Use '/agenfk-release' or '/agenfk-release-beta' to push to remote and cut a release."
echo "5. Run 'agenfk health' to verify your installation at any time."
