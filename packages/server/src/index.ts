#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
// @ts-ignore
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { execSync, spawn } from "child_process";

// Load the install-time secret token — must match what the API server loaded.
const VERIFY_TOKEN = (() => {
  const tokenPath = path.join(os.homedir(), '.agenfk', 'verify-token');
  try {
    return fs.readFileSync(tokenPath, 'utf8').trim();
  } catch {
    return ''; // Token missing — verify_changes calls will be rejected by the API server.
  }
})();

const API_URL = process.env.AGENFK_API_URL || "http://127.0.0.1:3000";

const api = axios.create({
  baseURL: API_URL,
  timeout: 30000,
});

const findProjectRoot = (startDir: string): string => {
  if (process.env.AGENFK_PROJECT_ROOT) {
    return process.env.AGENFK_PROJECT_ROOT;
  }
  if (process.env.AGENFK_DB_PATH) {
    return path.dirname(path.dirname(process.env.AGENFK_DB_PATH));
  }
  let currentDir = startDir;
  while (currentDir !== path.parse(currentDir).root) {
    if (fs.existsSync(path.join(currentDir, ".agenfk"))) {
      return currentDir;
    }
    currentDir = path.dirname(currentDir);
  }
  return startDir;
};

const server = new Server(
  {
    name: "agenfk-mcp-server",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Define Tool Schemas
const CreateProjectSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
});

const CreateItemSchema = z.object({
  projectId: z.string(),
  type: z.enum(["EPIC", "STORY", "TASK", "BUG"]),
  title: z.string(),
  description: z.string().optional(),
  parentId: z.string().optional(),
  status: z.enum(["TODO", "IN_PROGRESS", "TEST", "REVIEW", "DONE", "BLOCKED"]).optional(),
  implementationPlan: z.string().optional(),
});

const UpdateItemSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  status: z.enum(["TODO", "IN_PROGRESS", "TEST", "REVIEW", "DONE", "BLOCKED"]).optional(),
  implementationPlan: z.string().optional(),
});

const ListItemsSchema = z.object({
  projectId: z.string().optional(),
  type: z.enum(["EPIC", "STORY", "TASK", "BUG"]).optional(),
  status: z.enum(["TODO", "IN_PROGRESS", "TEST", "REVIEW", "DONE", "BLOCKED"]).optional(),
  parentId: z.string().optional(),
});

const GetItemSchema = z.object({
  id: z.string(),
});

const LogTokenUsageSchema = z.object({
  itemId: z.string(),
  input: z.number(),
  output: z.number(),
  model: z.string(),
  cost: z.number().optional(),
});

const AddContextSchema = z.object({
  itemId: z.string(),
  path: z.string(),
  description: z.string().optional(),
  content: z.string().optional(),
});

const AddCommentSchema = z.object({
  itemId: z.string(),
  content: z.string(),
  author: z.string().optional(),
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "list_projects",
        description: "List all existing AgenFK projects.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "create_project",
        description: "Create a new AgenFK project.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "The name of the project." },
            description: { type: "string", description: "A brief description." },
          },
          required: ["name"],
        },
      },
      {
        name: "create_item",
        description: "Create a new Epic, Story, Task, or Bug in the AgenFK framework.",
        inputSchema: {
          type: "object",
          properties: {
            projectId: { type: "string" },
            type: { type: "string", enum: ["EPIC", "STORY", "TASK", "BUG"] },
            title: { type: "string" },
            description: { type: "string" },
            parentId: { type: "string" },
            status: { type: "string", enum: ["TODO", "IN_PROGRESS", "TEST", "REVIEW", "DONE", "BLOCKED"] },
            implementationPlan: { type: "string" },
          },
          required: ["projectId", "type", "title"],
        },
      },
      {
        name: "update_item",
        description: "Update an existing item's status, title, or description. IMPORTANT: Cannot set status to DONE or REVIEW directly — use 'verify_changes' instead.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            description: { type: "string" },
            status: { type: "string", enum: ["TODO", "IN_PROGRESS", "TEST", "REVIEW", "DONE", "BLOCKED"] },
            implementationPlan: { type: "string" },
          },
          required: ["id"],
        },
      },
      {
        name: "list_items",
        description: "List items, optionally filtering by project, type, status, or parent.",
        inputSchema: {
          type: "object",
          properties: {
            projectId: { type: "string" },
            type: { type: "string", enum: ["EPIC", "STORY", "TASK", "BUG"] },
            status: { type: "string", enum: ["TODO", "IN_PROGRESS", "TEST", "REVIEW", "DONE", "BLOCKED"] },
            parentId: { type: "string" },
          },
        },
      },
      {
        name: "get_item",
        description: "Get details of a specific item by ID.",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
      {
        name: "delete_item",
        description: "Move an item and its children to the trash (TRASHED status). Use with caution.",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
      {
        name: "log_token_usage",
        description: "Log token usage for an item.",
        inputSchema: {
          type: "object",
          properties: {
            itemId: { type: "string" },
            input: { type: "number" },
            output: { type: "number" },
            model: { type: "string" },
            cost: { type: "number" },
          },
          required: ["itemId", "input", "output", "model"],
        },
      },
      {
        name: "add_comment",
        description: "Add a comment to an item to log progress or steps.",
        inputSchema: {
          type: "object",
          properties: {
            itemId: { type: "string" },
            content: { type: "string", description: "The comment text." },
            author: { type: "string", description: "Optional author name (e.g. 'opencode')." },
          },
          required: ["itemId", "content"],
        },
      },
      {
        name: "add_context",
        description: "Attach a file or context to an item.",
        inputSchema: {
          type: "object",
          properties: {
            itemId: { type: "string" },
            path: { type: "string" },
            description: { type: "string" },
            content: { type: "string" },
          },
          required: ["itemId", "path"],
        },
      },
      {
        name: "get_server_info",
        description: "Get information about the AgenFK server.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "workflow_gatekeeper",
        description: "Mandatory pre-flight check before any code change. Verifies that an active task exists and the agent role matches the phase.",
        inputSchema: {
          type: "object",
          properties: { 
            intent: { type: "string" },
            role: { type: "string", enum: ["planning", "coding", "review", "testing", "closing"], description: "The specialized role of the current agent." },
            itemId: { type: "string", description: "Optional: The specific item ID to authorize against. Required if multiple items are IN_PROGRESS." }
          },
          required: ["intent", "role"],
        },
      },
      {
        name: "analyze_request",
        description: "Analyze a user request to suggest the appropriate AgenFK item type.",
        inputSchema: {
          type: "object",
          properties: { request: { type: "string" } },
          required: ["request"],
        },
      },
      {
        name: "verify_changes",
        description: "Executes a verification command and automatically updates the task status.",
        inputSchema: {
          type: "object",
          properties: {
            itemId: { type: "string" },
            command: { type: "string" },
          },
          required: ["itemId", "command"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
  try {
    switch (request.params.name) {
      case "list_projects": {
        const { data } = await api.get(`/projects`);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }
      case "create_project": {
        const args = CreateProjectSchema.parse(request.params.arguments);
        const { data } = await api.post(`/projects`, args);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }
      case "verify_changes": {
        const { itemId, command } = z.object({ itemId: z.string(), command: z.string() }).parse(request.params.arguments);
        const verifyHeaders = { 'x-agenfk-internal': VERIFY_TOKEN };
        await api.put(`/items/${itemId}`, { status: "REVIEW" }, { headers: verifyHeaders });
        const projectRoot = findProjectRoot(process.cwd());

        const executeCommand = () => new Promise<{output: string, code: number | null}>((resolve, reject) => {
          const child = spawn(command, { 
            shell: true, 
            cwd: projectRoot,
            env: { ...process.env, FORCE_COLOR: '1' } 
          });
          let output = '';
          child.stdout.on('data', (data) => {
            output += data.toString();
          });
          child.stderr.on('data', (data) => {
            output += data.toString();
          });
          child.on('close', (code) => resolve({ output, code }));
          child.on('error', (err) => reject(err));
        });

        try {
          const { output, code } = await executeCommand();
          if (code !== 0) {
            const err: any = new Error(`Command failed with code ${code}`);
            err.stdout = output;
            throw err;
          }

          const { data: item } = await api.get(`/items/${itemId}`);
          const reviews = item.reviews || [];
          reviews.push({ id: uuidv4(), command, output, status: "PASSED", executedAt: new Date() });
          // Move to REVIEW. The Review Agent will perform an audit before moving to TEST.
          await api.put(`/items/${itemId}`, { status: "REVIEW", reviews }, { headers: verifyHeaders });
          return { content: [{ type: "text", text: `✅ Initial Verification Successful!\n\nCommand: \`${command}\`\nItem moved to REVIEW column.\n\nREMINDER: A Review Agent will now be spawned to audit your changes before testing begins.` }] };
        } catch (error: any) {
          const errorOutput = (error.stdout || '') + (error.stderr || '') + (error.message || '');
          try {
            const { data: item } = await api.get(`/items/${itemId}`);
            const reviews = item.reviews || [];
            reviews.push({ id: uuidv4(), command, output: errorOutput, status: "FAILED", executedAt: new Date() });
            await api.put(`/items/${itemId}`, { status: "IN_PROGRESS", reviews });
          } catch (e) {}
          return { isError: true, content: [{ type: "text", text: `❌ Verification Failed!\n\nCommand: \`${command}\`\nRoot: \`${projectRoot}\`\n\nErrors:\n${errorOutput}` }] };
        }
      }
      case "workflow_gatekeeper": {
        const { intent, role, itemId } = z.object({ 
          intent: z.string(), 
          role: z.enum(["planning", "coding", "review", "testing", "closing"]),
          itemId: z.string().optional()
        }).parse(request.params.arguments);

        // Fetch all non-DONE/ARCHIVED items
        const { data: items } = await api.get(`/items`);
        
        // Find items that are not in terminal states
        const activeItems = items.filter((i: any) => 
          i.status !== 'DONE' && i.status !== 'ARCHIVED' && (i.type === 'TASK' || i.type === 'BUG' || i.type === 'STORY')
        );

        const inProgressItems = activeItems.filter((i: any) => i.status === 'IN_PROGRESS');
        const reviewItems = activeItems.filter((i: any) => i.status === 'REVIEW');
        const testItems = activeItems.filter((i: any) => i.status === 'TEST');

        // Enforcement Logic
        if (role === 'coding') {
          if (inProgressItems.length === 0) return { isError: true, content: [{ type: "text", text: `❌ WORKFLOW BREACH: Coding role requires a task in IN_PROGRESS status.` }] };
          
          let task;
          if (itemId) {
            task = inProgressItems.find((i: any) => i.id === itemId);
            if (!task) return { isError: true, content: [{ type: "text", text: `❌ WORKFLOW BREACH: Item [${itemId}] is not in IN_PROGRESS status.` }] };
          } else {
            if (inProgressItems.length > 1) return { isError: true, content: [{ type: "text", text: `⚠️ AMBIGUOUS WORKFLOW: Multiple tasks are IN_PROGRESS. Please provide 'itemId' to disambiguate.` }] };
            task = inProgressItems[0];
          }
          
          return { content: [{ type: "text", text: `✅ AUTHORIZED (CODING).\n\nTask: [${task.id.substring(0,8)}] ${task.title}\nIntent: "${intent}"` }] };
        }

        if (role === 'review') {
          const activeReviewItems = itemId ? reviewItems.filter((i: any) => i.id === itemId) : reviewItems;
          if (activeReviewItems.length === 0) return { isError: true, content: [{ type: "text", text: `❌ WORKFLOW BREACH: Review role requires a task in REVIEW status.` }] };
          const task = activeReviewItems[0];
          return { content: [{ type: "text", text: `✅ AUTHORIZED (REVIEW).\n\nTask: [${task.id.substring(0,8)}] ${task.title}\nIntent: "${intent}"` }] };
        }

        if (role === 'testing') {
          const activeTestItems = itemId ? testItems.filter((i: any) => i.id === itemId) : testItems;
          if (activeTestItems.length === 0) return { isError: true, content: [{ type: "text", text: `❌ WORKFLOW BREACH: Testing role requires a task in TEST status.` }] };
          const task = activeTestItems[0];
          return { content: [{ type: "text", text: `✅ AUTHORIZED (TESTING).\n\nTask: [${task.id.substring(0,8)}] ${task.title}\nIntent: "${intent}"` }] };
        }

        // Default to checking for IN_PROGRESS if role is generic or unrecognized
        if (inProgressItems.length === 0) {
          return { isError: true, content: [{ type: "text", text: `❌ WORKFLOW BREACH: No task is currently IN_PROGRESS.` }] };
        }
        
        const defaultTask = itemId ? inProgressItems.find((i: any) => i.id === itemId) : inProgressItems[0];
        if (!defaultTask) return { isError: true, content: [{ type: "text", text: `❌ WORKFLOW BREACH: Specified item is not IN_PROGRESS.` }] };

        return { content: [{ type: "text", text: `✅ WORKFLOW VALIDATED.\n\nActive Item: [${defaultTask.id.substring(0,8)}] ${defaultTask.title}\nIntent: "${intent}"` }] };
      }
      case "analyze_request": {
        const { request: userRequest } = z.object({ request: z.string() }).parse(request.params.arguments);
        return { 
          content: [{ 
            type: "text", 
            text: `Complexity analysis for: "${userRequest}"\n\nREMINDER: If this request is complex (multiple steps/components), you MUST:\n1. Categorize as EPIC or STORY.\n2. Create ALL sub-items (Stories/Tasks) in TODO status.\n3. PAUSE and ask the user for approval of the plan before moving any item to IN_PROGRESS.` 
          }] 
        };
      }
      case "get_server_info": {
        const { data } = await api.get(`/`);
        const projectRoot = findProjectRoot(process.cwd());
        return { 
          content: [{ 
            type: "text", 
            text: JSON.stringify({ 
              mcp: "agenfk-mcp-server", 
              api: data, 
              api_url: API_URL,
              env: {
                AGENFK_DB_PATH: process.env.AGENFK_DB_PATH,
                AGENFK_PROJECT_ROOT: process.env.AGENFK_PROJECT_ROOT
              },
              derivedProjectRoot: projectRoot,
              cwd: process.cwd()
            }, null, 2) 
          }] 
        };
      }
      case "create_item": {
        const args = CreateItemSchema.parse(request.params.arguments);
        const { data } = await api.post(`/items`, args);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }
      case "update_item": {
        const args = UpdateItemSchema.parse(request.params.arguments);
        const { id, ...updates } = args;

        // Fetch current item to check status for state machine transitions
        const { data: currentItem } = await api.get(`/items/${id}`);

        // Enforce REVIEW/TEST workflow: block direct transitions to DONE unless from TEST
        if (updates.status === "DONE") {
          if (currentItem.status !== "TEST") {
            return {
              isError: true,
              content: [{ type: "text", text: `❌ WORKFLOW VIOLATION: Cannot set status to DONE directly from ${currentItem.status}. You MUST move through TEST column first. Use 'verify_changes(itemId, command)' to reach TEST.` }],
            };
          }
          // Allow TEST -> DONE, using verify token to bypass server guard
          const { data } = await api.put(`/items/${id}`, updates, { headers: { 'x-agenfk-internal': VERIFY_TOKEN } });
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        }

        if (updates.status === "REVIEW") {
          return {
            isError: true,
            content: [{ type: "text", text: `❌ WORKFLOW VIOLATION: Cannot set status to REVIEW directly via update_item. The REVIEW state is managed automatically by 'verify_changes(itemId, command)'. Call verify_changes instead.` }],
          };
        }

        const { data } = await api.put(`/items/${id}`, updates);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }
      case "list_items": {
        const args = ListItemsSchema.parse(request.params.arguments || {});
        const { data } = await api.get(`/items`, { params: args });
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }
      case "get_item": {
        const args = GetItemSchema.parse(request.params.arguments);
        const { data } = await api.get(`/items/${args.id}`);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }
      case "delete_item": {
        const { id } = z.object({ id: z.string() }).parse(request.params.arguments);
        await api.delete(`/items/${id}`);
        return { content: [{ type: "text", text: `Item ${id} and its children moved to trash.` }] };
      }
      case "log_token_usage": {
        const args = LogTokenUsageSchema.parse(request.params.arguments);
        const { itemId, ...usage } = args;
        const { data: item } = await api.get(`/items/${itemId}`);
        const tokenUsage = item.tokenUsage || [];
        tokenUsage.push(usage);
        await api.put(`/items/${itemId}`, { tokenUsage });
        return { content: [{ type: "text", text: "Token usage logged." }] };
      }
      case "add_comment": {
        const args = AddCommentSchema.parse(request.params.arguments);
        const { itemId, content, author } = args;
        const { data: item } = await api.get(`/items/${itemId}`);
        const comments = item.comments || [];
        comments.push({ 
          id: uuidv4(), 
          content, 
          author: author || "agent", 
          timestamp: new Date() 
        });
        await api.put(`/items/${itemId}`, { comments });
        return { content: [{ type: "text", text: "Comment added." }] };
      }
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
    }
  } catch (error: any) {
    let errorMessage = error.message;
    if (error.response) errorMessage = `API Error (${error.response.status}): ${JSON.stringify(error.response.data)}`;
    else if (error.code === 'ECONNREFUSED') errorMessage = `Could not connect to AgenFK API at ${API_URL}.`;
    return { content: [{ type: "text", text: `❌ Error: ${errorMessage}` }], isError: true };
  }
});

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("AgenFK MCP Server running on stdio (Client Mode)");
}

run().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});
