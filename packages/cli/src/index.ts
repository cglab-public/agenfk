import { Command } from 'commander';
import chalk from 'chalk';
import figlet from 'figlet';
import axios from 'axios';
import { ItemType, Status } from '@agentic/core';
import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const program = new Command();
const API_URL = process.env.AGENTIC_API_URL || "http://localhost:3000";

console.log(
  chalk.cyan(
    figlet.textSync('agenfk', { horizontalLayout: 'full' })
  )
);

program
  .version('0.1.0')
  .description('Agentic Engineering CLI');

program
  .command('up')
  .description('Bootstrap and start Agentic Engineering Framework')
  .action(async () => {
    const rootDir = path.resolve(__dirname, '../../..');
    console.log(chalk.blue('🚀 Bringing up Agentic Engineering Framework (agenfk)...'));
    
    // Check if bootstrap required
    const agenticDir = path.join(rootDir, '.agentic');
    const serverDist = path.join(rootDir, 'packages/server/dist/server.js');
    
    if (!fs.existsSync(agenticDir) || !fs.existsSync(serverDist)) {
        console.log(chalk.yellow('📦 Initial bootstrap required...'));
        try {
            execSync('./integrate_opencode.sh', { cwd: rootDir, stdio: 'inherit' });
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
  .description('Show dashboard information')
  .action(() => {
    console.log(chalk.cyan('🌐 Opening UI...'));
    console.log(chalk.white('Dashboard: http://localhost:5173'));
  });

program
  .command('init')
  .description('Initialize a new Agentic project (Note: Ensure API server is running)')
  .action(async () => {
    try {
        const { data } = await axios.get(`${API_URL}/`);
        console.log(chalk.green('Connected to Agentic API Server.'));
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
  .action(async (type, title, options) => {
    try {
      const itemType = type.toUpperCase() as ItemType;
      
      const payload = {
        type: itemType,
        title,
        description: options.description,
        parentId: options.parent
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

program.parse(process.argv);
