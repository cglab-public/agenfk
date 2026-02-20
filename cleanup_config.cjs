const fs = require('fs');
const path = require('path');
const configPath = path.join(process.env.HOME, '.config', 'opencode', 'opencode.json');

try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (config.mcp && config.mcp.agentic) {
        delete config.mcp.agentic;
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        console.log('Successfully removed old agentic MCP entry.');
    }
} catch (e) {
    console.error('Error updating opencode.json:', e);
}
