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
import { execSync } from "child_process";

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
        description: "Mandatory pre-flight check before any code change. Verifies that an active task exists.",
        inputSchema: {
          type: "object",
          properties: { intent: { type: "string" } },
          required: ["intent"],
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
        try {
          const output = execSync(command, { encoding: 'utf8', stdio: 'pipe', cwd: projectRoot });
          const { data: item } = await api.get(`/items/${itemId}`);
          const reviews = item.reviews || [];
          reviews.push({ id: uuidv4(), command, output, status: "PASSED", executedAt: new Date() });
          // Move to TEST instead of DONE to trigger automated coverage check
          await api.put(`/items/${itemId}`, { status: "TEST", reviews }, { headers: verifyHeaders });
          return { content: [{ type: "text", text: `✅ Verification Successful!\n\nCommand: \`${command}\`\nItem moved to TEST column for automated coverage check.` }] };
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
        const { intent } = z.object({ intent: z.string() }).parse(request.params.arguments);
        const { data: items } = await api.get(`/items`, { params: { status: "IN_PROGRESS" } });
        // Strictly only allow one leaf-level work item (TASK or BUG)
        const inProgressItems = items.filter((i: any) => i.type === 'TASK' || i.type === 'BUG');
        
        if (inProgressItems.length === 0) {
          return { isError: true, content: [{ type: "text", text: `❌ WORKFLOW BREACH: No task is currently IN_PROGRESS.` }] };
        }
        if (inProgressItems.length > 1) {
          return { isError: true, content: [{ type: "text", text: `⚠️ AMBIGUOUS WORKFLOW: Multiple tasks are currently IN_PROGRESS.` }] };
        }
        const activeTask = inProgressItems[0];
        let reminder = `REMINDER: Move to REVIEW and run 'verify_changes' before completion.`;
        if (activeTask.type === 'STORY') {
          reminder = `STORY REMINDER: If this story has no sub-tasks, you MUST call 'verify_changes' manually before it can be DONE. If it has sub-tasks, it will be implicitly reviewed via its children.`;
        }
        return { content: [{ type: "text", text: `✅ WORKFLOW VALIDATED.\n\nActive Item: [${activeTask.id.substring(0,8)}] ${activeTask.title}\nIntent: "${intent}"\n\n${reminder}\n\nTOKEN REMINDER: Do not forget to call 'log_token_usage' explicitly when you finish this segment of work.` }] };
      }
      case "analyze_request": {
        const { request: userRequest } = z.object({ request: z.string() }).parse(request.params.arguments);
        return { content: [{ type: "text", text: `Framework Analysis Strategy applied to: "${userRequest}"` }] };
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

        // Enforce REVIEW workflow: block direct transitions to DONE or REVIEW
        if (updates.status === "DONE") {
          return {
            isError: true,
            content: [{ type: "text", text: `❌ WORKFLOW VIOLATION: Cannot set status to DONE directly via update_item. You MUST use 'verify_changes(itemId, command)' to validate your work before completion. The verify_changes tool will move the item through REVIEW → DONE automatically.` }],
          };
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
      case "log_token_usage": {
        const args = LogTokenUsageSchema.parse(request.params.arguments);
        const { itemId, ...usage } = args;
        const { data: item } = await api.get(`/items/${itemId}`);
        const tokenUsage = item.tokenUsage || [];
        tokenUsage.push(usage);
        await api.put(`/items/${itemId}`, { tokenUsage });
        return { content: [{ type: "text", text: "Token usage logged." }] };
      }
      case "add_context": {
        const args = AddContextSchema.parse(request.params.arguments);
        const { itemId, ...contextItem } = args;
        const { data: item } = await api.get(`/items/${itemId}`);
        const context = item.context || [];
        context.push({ id: uuidv4(), ...contextItem });
        await api.put(`/items/${itemId}`, { context });
        return { content: [{ type: "text", text: "Context added." }] };
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
