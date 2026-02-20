import { Command } from 'commander';
import chalk from 'chalk';
import figlet from 'figlet';
import axios from 'axios';
import { ItemType, Status } from '@agenfk/core';
import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const program = new Command();
const API_URL = process.env.AGENFK_API_URL || "http://localhost:3000";

console.log(
  chalk.cyan(
    figlet.textSync('agenfk', { horizontalLayout: 'full' })
  )
);

program
  .version('0.1.0')
  .description('AgenFK Engineering CLI');

program
  .command('up')
  .description('Bootstrap and start AgenFK Engineering Framework')
  .action(async () => {
    const rootDir = path.resolve(__dirname, '../../..');
    console.log(chalk.blue('🚀 Bringing up AgenFK Engineering Framework (agenfk)...'));
    
    // Check if bootstrap required
    const agenfkDir = path.join(rootDir, '.agenfk');
    const serverDist = path.join(rootDir, 'packages/server/dist/server.js');
    
    if (!fs.existsSync(agenfkDir) || !fs.existsSync(serverDist)) {
        console.log(chalk.yellow('📦 Initial bootstrap required...'));
        try {
            execSync('./install.sh', { cwd: rootDir, stdio: 'inherit' });
        } catch (e) {
            console.error(chalk.red('Bootstrap failed.'));
            return;
        }
    }
    
    console.log(chalk.blue('⚡ Starting agenfk services...'));
    try {
        const start = spawn('./start-services.sh', { cwd: rootDir, stdio: 'inherit' });
        start.on('close', (code) => {
            process.exit(code || 0);
        });
    } catch (e) {
        console.error(chalk.red('Failed to start services.'));
    }
  });

program
  .command('ui')
  .description('Show dashboard information and open in browser')
  .action(() => {
    console.log(chalk.cyan('🌐 Opening UI...'));
    console.log(chalk.white('Dashboard: http://localhost:5173'));
    
    const uiUrl = 'http://localhost:5173';
    try {
      if (fs.existsSync('/proc/version') && fs.readFileSync('/proc/version', 'utf8').match(/(Microsoft|WSL)/i)) {
        execSync(`explorer.exe "${uiUrl}"`, { stdio: 'ignore' });
      } else if (process.platform === 'linux') {
        execSync(`xdg-open "${uiUrl}"`, { stdio: 'ignore' });
      } else if (process.platform === 'darwin') {
        execSync(`open "${uiUrl}"`, { stdio: 'ignore' });
      }
    } catch (e) {
      // Ignore errors if browser launch fails
    }
  });

program
  .command('list-projects')
  .description('List all projects')
  .action(async () => {
    try {
      const { data: projects } = await axios.get(`${API_URL}/projects`);
      console.table(projects.map((p: any) => ({
        ID: p.id,
        Name: p.name,
        Created: new Date(p.createdAt).toLocaleDateString()
      })));
    } catch (error: any) {
      console.error(chalk.red('Error listing projects:'), error.message);
    }
  });

program
  .command('create-project <name>')
  .description('Create a new project')
  .option('-d, --description <desc>', 'Project description', '')
  .action(async (name, options) => {
    try {
      const { data } = await axios.post(`${API_URL}/projects`, { name, description: options.description });
      console.log(chalk.green(`Created project: ${data.name} (ID: ${data.id})`));
    } catch (error: any) {
      console.error(chalk.red('Error creating project:'), error.message);
    }
  });

program
  .command('init')
  .description('Initialize a new AgenFK project (Note: Ensure API server is running)')
  .action(async () => {
    try {
        const { data } = await axios.get(`${API_URL}/`);
        console.log(chalk.green('Connected to AgenFK API Server.'));
        console.log(JSON.stringify(data, null, 2));
    } catch (e: any) {
        console.error(chalk.red('Could not connect to API server. Is it running on port 3000?'));
    }
  });

program
  .command('create <type> <title>')
  .description('Create a new item (epic, story, task, bug)')
  .option('-d, --description <desc>', 'Description of the item', '')
  .option('-p, --parent <id>', 'Parent ID')
  .option('--project <id>', 'Project ID')
  .action(async (type, title, options) => {
    try {
      const itemType = type.toUpperCase() as ItemType;
      
      let projectId = options.project;
      if (!projectId) {
        // Try to find in .agenfk/project.json
        const rootDir = path.resolve(__dirname, '../../..');
        const projFile = path.join(rootDir, '.agenfk', 'project.json');
        if (fs.existsSync(projFile)) {
          projectId = JSON.parse(fs.readFileSync(projFile, 'utf8')).projectId;
        }
      }

      if (!projectId) {
        console.error(chalk.red('Error: Project ID is required. Use --project <id> or initialize with agenfk init.'));
        process.exit(1);
      }

      const payload = {
        type: itemType,
        title,
        description: options.description,
        parentId: options.parent,
        projectId
      };

      const { data } = await axios.post(`${API_URL}/items`, payload);
      console.log(chalk.green(`Created ${type}: ${data.title} (ID: ${data.id})`));
    } catch (error: any) {
      console.error(chalk.red('Error creating item:'), error.response?.data?.error || error.message);
    }
  });

program
  .command('list')
  .description('List items')
  .option('-t, --type <type>', 'Filter by type')
  .option('-s, --status <status>', 'Filter by status')
  .action(async (options) => {
    try {
      const query: any = {};
      if (options.type) query.type = options.type.toUpperCase();
      if (options.status) query.status = options.status.toUpperCase();

      const { data: items } = await axios.get(`${API_URL}/items`, { params: query });
      
      if (items.length === 0) {
        console.log(chalk.yellow('No items found.'));
        return;
      }

      console.table(items.map((i: any) => ({
        ID: i.id.substring(0, 8),
        Type: i.type,
        Title: i.title.substring(0, 50),
        Status: i.status,
        Parent: i.parentId ? i.parentId.substring(0, 8) : '-'
      })));
    } catch (error: any) {
      console.error(chalk.red('Error listing items:'), error.response?.data?.error || error.message);
    }
  });

program
  .command('update <id>')
  .description('Update an item')
  .option('-s, --status <status>', 'New status (TODO, IN_PROGRESS, REVIEW, DONE, BLOCKED)')
  .option('-t, --title <title>', 'New title')
  .option('-d, --description <desc>', 'New description')
  .action(async (id, options) => {
    try {
      // Handle short ID
      let targetId = id;
      if (id.length < 36) {
        const { data: allItems } = await axios.get(`${API_URL}/items`);
        const found = allItems.filter((i: any) => i.id.startsWith(id));
        if (found.length === 0) {
           console.error(chalk.red(`Item starting with ${id} not found.`));
           return;
        }
        if (found.length > 1) {
           console.error(chalk.red(`Ambiguous ID ${id}, matches multiple items.`));
           return;
        }
        targetId = found[0].id;
      }

      const updates: any = {};
      if (options.status) updates.status = options.status.toUpperCase();
      if (options.title) updates.title = options.title;
      if (options.description) updates.description = options.description;

      const { data: updated } = await axios.put(`${API_URL}/items/${targetId}`, updates);
      console.log(chalk.green(`Updated item: ${updated.title} (${updated.status})`));
    } catch (error: any) {
      console.error(chalk.red('Error updating item:'), error.response?.data?.error || error.message);
    }
  });

program
  .command('delete <id>')
  .description('Delete an item')
  .action(async (id) => {
    try {
      let targetId = id;
      if (id.length < 36) {
        const { data: allItems } = await axios.get(`${API_URL}/items`);
        const found = allItems.filter((i: any) => i.id.startsWith(id));
        if (found.length === 0) {
           console.error(chalk.red(`Item starting with ${id} not found.`));
           return;
        }
        targetId = found[0].id;
      }

      await axios.delete(`${API_URL}/items/${targetId}`);
      console.log(chalk.green(`Deleted item ${targetId}`));
    } catch (error: any) {
      console.error(chalk.red('Error deleting item:'), error.response?.data?.error || error.message);
    }
  });

program
  .command('health')
  .description('Verify framework health and configuration')
  .action(async () => {
    console.log(chalk.blue('\n🔍 AgenFK Health Check\n'));
    let issues = 0;

    // 1. API Server Check
    process.stdout.write('Checking API Server... ');
    try {
      const { data } = await axios.get(`${API_URL}/`);
      console.log(chalk.green('OK'));
      console.log(chalk.gray(`   - Message: ${data.message}`));
    } catch (e: any) {
      console.log(chalk.red('FAILED'));
      console.log(chalk.yellow(`   - Error: Could not connect to ${API_URL}`));
      issues++;
    }

    // 2. Configuration & DB Check
    process.stdout.write('Checking Database... ');
    const rootDir = path.resolve(__dirname, '../../..');
    const dbPath = process.env.AGENFK_DB_PATH || path.join(rootDir, '.agenfk', 'db.json');
    if (fs.existsSync(dbPath)) {
      console.log(chalk.green('OK'));
      console.log(chalk.gray(`   - Path: ${dbPath}`));
      try {
        const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
        console.log(chalk.gray(`   - Items: ${db.items.length}`));
      } catch (e) {
        console.log(chalk.red('   - Error: Could not parse db.json'));
        issues++;
      }
    } else {
      console.log(chalk.red('MISSING'));
      issues++;
    }

    // 3. MCP Config Check
    process.stdout.write('Checking Opencode MCP Config... ');
    const opencodeConfig = path.join(process.env.HOME || '', '.config', 'opencode', 'opencode.json');
    if (fs.existsSync(opencodeConfig)) {
      try {
        const config = JSON.parse(fs.readFileSync(opencodeConfig, 'utf8'));
        if (config.mcp && config.mcp.agenfk) {
          console.log(chalk.green('OK'));
          console.log(chalk.gray(`   - Enabled: ${config.mcp.agenfk.enabled}`));
        } else {
          console.log(chalk.yellow('NOT CONFIGURED'));
          issues++;
        }
      } catch (e) {
        console.log(chalk.red('ERROR READING CONFIG'));
        issues++;
      }
    } else {
      console.log(chalk.gray('N/A (Opencode not detected)'));
    }

    // 4. Skills Check
    process.stdout.write('Checking Global Skills... ');
    const skillPath = path.join(process.env.HOME || '', '.config', 'opencode', 'skills', 'agenfk', 'SKILL.md');
    if (fs.existsSync(skillPath)) {
      console.log(chalk.green('OK'));
    } else {
      console.log(chalk.yellow('MISSING'));
      issues++;
    }

    console.log('\n' + (issues === 0 
      ? chalk.green('✨ All systems healthy!') 
      : chalk.yellow(`⚠️ Found ${issues} potential issue(s). Run './agenfk up' to fix.`)) + '\n');
  });

program.parse(process.argv);
