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
import { execSync, spawnSync, spawn } from "child_process";

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

const findProjectId = (startDir: string): string | null => {
  const root = findProjectRoot(startDir);
  const projFile = path.join(root, ".agenfk", "project.json");
  if (fs.existsSync(projFile)) {
    try {
      const config = JSON.parse(fs.readFileSync(projFile, "utf8"));
      return config.projectId || null;
    } catch {
      return null;
    }
  }
  return null;
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
  type: z.enum(["EPIC", "STORY", "TASK", "BUG"]).optional(),
  implementationPlan: z.string().optional(),
});

const ListItemsSchema = z.object({
  projectId: z.string(),
  type: z.enum(["EPIC", "STORY", "TASK", "BUG"]).optional(),
  status: z.enum(["TODO", "IN_PROGRESS", "TEST", "REVIEW", "DONE", "BLOCKED"]),
  parentId: z.string().optional(),
  full: z.boolean().optional(), // Return full item objects if true
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
  sessionId: z.string().optional(),
  source: z.string().optional(),
  timestamp: z.string().optional(),
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
        name: "update_project",
        description: "Update an existing project's name, description, or verifyCommand.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "The project ID." },
            name: { type: "string", description: "New project name." },
            description: { type: "string", description: "New project description." },
            verifyCommand: { type: "string", description: "The command to run for test_changes (e.g. 'npm run build && npm test'). Once set, test_changes will always use this command to gate TEST → DONE." },
          },
          required: ["id"],
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
        description: "Update an existing item's status, title, or description. IMPORTANT: Cannot set status to DONE directly — use test_changes. Cannot set status to REVIEW directly — use review_changes.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            description: { type: "string" },
            status: { type: "string", enum: ["TODO", "IN_PROGRESS", "TEST", "REVIEW", "DONE", "BLOCKED"] },
            type: { type: "string", enum: ["EPIC", "STORY", "TASK", "BUG"] },
            implementationPlan: { type: "string" },
          },
          required: ["id"],
        },
      },
      {
        name: "list_items",
        description: "List items, filtering by project and status (required), plus optional type or parent.",
        inputSchema: {
          type: "object",
          properties: {
            projectId: { type: "string", description: "The ID of the project." },
            type: { type: "string", enum: ["EPIC", "STORY", "TASK", "BUG"] },
            status: { type: "string", enum: ["TODO", "IN_PROGRESS", "TEST", "REVIEW", "DONE", "BLOCKED"] },
            parentId: { type: "string" },
          },
          required: ["projectId", "status"],
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
        description: "Log token usage for an item. Use this for manual/proactive reporting. Note: Automated hooks will also capture session totals using 'sessionId' for deduplication.",
        inputSchema: {
          type: "object",
          properties: {
            itemId: { type: "string" },
            input: { type: "number" },
            output: { type: "number" },
            model: { type: "string" },
            cost: { type: "number" },
            sessionId: { type: "string", description: "Optional: session ID for deduplication with automated hooks." },
            source: { type: "string", description: "Optional: source of report (e.g. 'agent', 'manual')." },
            timestamp: { type: "string", description: "Optional: ISO timestamp." },
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
        name: "create_branch",
        description: "Create a git branch for an item. Computes the branch name (BUG → fix/, others → feature/), creates the local branch, switches to it, and stores branchName on the item. Only works for top-level items (no parentId).",
        inputSchema: {
          type: "object",
          properties: {
            itemId: { type: "string" },
          },
          required: ["itemId"],
        },
      },
      {
        name: "create_pr",
        description: "Push the item's branch to remote and create a GitHub pull request. Stores prUrl, prNumber, and prStatus on the item. Requires GitHub CLI (gh) and a branch already assigned to the item. Only works for top-level items (no parentId).",
        inputSchema: {
          type: "object",
          properties: {
            itemId: { type: "string" },
            description: { type: "string", description: "PR body/description written by the agent." },
            draft: { type: "boolean", description: "Create as a draft PR. Defaults to false." },
          },
          required: ["itemId"],
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
        name: "review_changes",
        description: "Runs an agent-chosen command to verify the implementation and moves the item from IN_PROGRESS → REVIEW. Use any command that makes sense (build, lint, type-check, etc.). If the command fails, the item stays IN_PROGRESS.",
        inputSchema: {
          type: "object",
          properties: {
            itemId: { type: "string" },
            command: { type: "string", description: "The command to run (e.g. 'npm run build', 'cargo check')." },
          },
          required: ["itemId", "command"],
        },
      },
      {
        name: "test_changes",
        description: "Runs the project's verifyCommand (test suite) and moves the item from TEST → DONE. No command parameter — the project's verifyCommand is always used. If no verifyCommand is configured, returns an error — ask the developer to set one via update_project.",
        inputSchema: {
          type: "object",
          properties: {
            itemId: { type: "string" },
          },
          required: ["itemId"],
        },
      },
      {
        name: "log_test_result",
        description: "Logs the result of a test execution for an item.",
        inputSchema: {
          type: "object",
          properties: {
            itemId: { type: "string" },
            command: { type: "string" },
            output: { type: "string" },
            status: { type: "string", enum: ["PASSED", "FAILED"] },
          },
          required: ["itemId", "command", "output", "status"],
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
      case "update_project": {
        const { id, ...updates } = z.object({
          id: z.string(),
          name: z.string().optional(),
          description: z.string().optional(),
          verifyCommand: z.string().optional(),
        }).parse(request.params.arguments);
        const { data } = await api.put(`/projects/${id}`, updates);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }
      case "log_test_result": {
        const { itemId, command, output, status } = z.object({ 
          itemId: z.string(), 
          command: z.string(), 
          output: z.string(), 
          status: z.enum(["PASSED", "FAILED"]) 
        }).parse(request.params.arguments);
        
        try {
          const { data: item } = await api.get(`/items/${itemId}`);
          const tests = item.tests || [];
          tests.push({ id: uuidv4(), command, output, status, executedAt: new Date() });
          await api.put(`/items/${itemId}`, { tests });
          return { content: [{ type: "text", text: `✅ Test result logged for item [${itemId}].` }] };
        } catch (error: any) {
          return { isError: true, content: [{ type: "text", text: `❌ Failed to log test result: ${error.message}` }] };
        }
      }
      case "review_changes": {
        const { itemId, command } = z.object({ itemId: z.string(), command: z.string() }).parse(request.params.arguments);
        try {
          const { data } = await api.post(`/items/${itemId}/review`, { command }, { headers: { 'x-agenfk-internal': VERIFY_TOKEN } });
          return { content: [{ type: "text", text: data.message }] };
        } catch (error: any) {
          const msg = error.response?.data?.message || error.response?.data?.error || error.message;
          return { isError: true, content: [{ type: "text", text: msg }] };
        }
      }
      case "test_changes": {
        const { itemId } = z.object({ itemId: z.string() }).parse(request.params.arguments);
        try {
          const { data } = await api.post(`/items/${itemId}/test`, {}, { headers: { 'x-agenfk-internal': VERIFY_TOKEN } });
          return { content: [{ type: "text", text: data.message }] };
        } catch (error: any) {
          const msg = error.response?.data?.message || error.response?.data?.error || error.message;
          return { isError: true, content: [{ type: "text", text: msg }] };
        }
      }
      case "workflow_gatekeeper": {
        const { intent, role, itemId } = z.object({ 
          intent: z.string(), 
          role: z.enum(["planning", "coding", "review", "testing", "closing"]),
          itemId: z.string().optional()
        }).parse(request.params.arguments);

        // Resolve the effective Project ID
        let effectiveProjectId: string | undefined | null;
        let providedItem: any;

        if (itemId) {
          try {
            const { data: item } = await api.get(`/items/${itemId}`);
            providedItem = item;
            effectiveProjectId = item.projectId;
          } catch (error: any) {
             return { isError: true, content: [{ type: "text", text: `❌ CONFIG ERROR: Item [${itemId}] not found in database.` }] };
          }
        } else {
          effectiveProjectId = findProjectId(process.cwd());
        }

        if (!effectiveProjectId) {
           return { isError: true, content: [{ type: "text", text: `❌ CONFIG ERROR: No AgenFK project found in the current directory, and no itemId was provided.` }] };
        }

        // Validate that the project exists in the database
        try {
          await api.get(`/projects/${effectiveProjectId}`);
        } catch (error: any) {
          return { isError: true, content: [{ type: "text", text: `❌ CONFIG ERROR: Project ID [${effectiveProjectId}] does not exist in the database.` }] };
        }

        // Fetch items and filter by project ID
        const { data: allItems } = await api.get(`/items`, { params: { projectId: effectiveProjectId } });
        
        // Find items that are not in terminal states
        const activeItems = allItems.filter((i: any) => 
          i.status !== 'DONE' && i.status !== 'ARCHIVED' && i.status !== 'TRASHED' && (i.type === 'TASK' || i.type === 'BUG' || i.type === 'STORY' || i.type === 'EPIC')
        );

        const inProgressItems = activeItems.filter((i: any) => i.status === 'IN_PROGRESS');
        const reviewItems = activeItems.filter((i: any) => i.status === 'REVIEW');
        const testItems = activeItems.filter((i: any) => i.status === 'TEST');

        // Enforcement Logic
        if (role === 'planning') {
          if (!itemId) return { isError: true, content: [{ type: "text", text: `❌ WORKFLOW BREACH: itemId is required for the planning role.` }] };
          const item = providedItem; // Already fetched
          if (item.type !== 'EPIC' && item.type !== 'STORY') {
            return { isError: true, content: [{ type: "text", text: `❌ WORKFLOW BREACH: Planning role is only valid for EPIC or STORY items.` }] };
          }
          return { content: [{ type: "text", text: `✅ AUTHORIZED (PLANNING).\n\nItem: [${item.id.substring(0,8)}] ${item.title}\nIntent: "${intent}"` }] };
        }

        if (role === 'coding') {
          if (inProgressItems.length === 0) return { isError: true, content: [{ type: "text", text: `❌ WORKFLOW BREACH: Coding role requires a task in IN_PROGRESS status in project [${effectiveProjectId}].` }] };
          
          let task;
          if (itemId) {
            task = inProgressItems.find((i: any) => i.id === itemId);
            if (!task) return { isError: true, content: [{ type: "text", text: `❌ WORKFLOW BREACH: Item [${itemId}] is not IN_PROGRESS or does not belong to project [${effectiveProjectId}].` }] };
          } else {
            if (inProgressItems.length > 1) return { isError: true, content: [{ type: "text", text: `⚠️ AMBIGUOUS WORKFLOW: Multiple tasks are IN_PROGRESS in project [${effectiveProjectId}]. Please provide 'itemId' to disambiguate.` }] };
            task = inProgressItems[0];
          }

          if (task.type === 'EPIC' || task.type === 'STORY') {
             return { isError: true, content: [{ type: "text", text: `❌ WORKFLOW BREACH: Coding role is not allowed on ${task.type} items. Please decompose into TASKS and work on those instead.` }] };
          }

          // Auto-create git branch if branchName is set but branch doesn't exist locally
          let branchHint = '';
          if (task.branchName) {
            try {
              // Check if the branch exists locally
              try {
                execSync(`git rev-parse --verify ${task.branchName}`, { stdio: 'ignore' });
                // Branch exists — check if we're on it
                const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
                if (currentBranch !== task.branchName) {
                  execSync(`git checkout ${task.branchName}`, { stdio: 'ignore' });
                  branchHint = `\n🔀 Switched to branch '${task.branchName}'.`;
                } else {
                  branchHint = `\n🔀 Already on branch '${task.branchName}'.`;
                }
              } catch {
                // Branch doesn't exist locally — create and checkout
                execSync(`git checkout -b ${task.branchName}`, { stdio: 'ignore' });
                branchHint = `\n🔀 Created and switched to branch '${task.branchName}'.`;
              }
            } catch (gitErr: any) {
              branchHint = `\n⚠️ Could not auto-checkout branch '${task.branchName}': ${gitErr.message}. You may need to handle this manually.`;
            }
          } else if (task.type === 'TASK' && !task.parentId) {
            branchHint = '\n💡 This TASK has no branch. You may offer the developer to create one with the `create_branch` MCP tool, or continue on the current branch.';
          }

          return { content: [{ type: "text", text: `✅ AUTHORIZED (CODING).\n\n${task.type}: [${task.id.substring(0,8)}] ${task.title}\nIntent: "${intent}"${branchHint}` }] };
        }

        if (role === 'review') {
          const activeReviewItems = itemId ? reviewItems.filter((i: any) => i.id === itemId) : reviewItems;
          if (activeReviewItems.length === 0) return { isError: true, content: [{ type: "text", text: `❌ WORKFLOW BREACH: Review role requires a task in REVIEW status in project [${effectiveProjectId}].` }] };
          const task = activeReviewItems[0];
          return { content: [{ type: "text", text: `✅ AUTHORIZED (REVIEW).\n\n${task.type}: [${task.id.substring(0,8)}] ${task.title}\nIntent: "${intent}"` }] };
        }

        if (role === 'testing') {
          const activeTestItems = itemId ? testItems.filter((i: any) => i.id === itemId) : testItems;
          if (activeTestItems.length === 0) return { isError: true, content: [{ type: "text", text: `❌ WORKFLOW BREACH: Testing role requires a task in TEST status in project [${effectiveProjectId}].` }] };
          const task = activeTestItems[0];
          return { content: [{ type: "text", text: `✅ AUTHORIZED (TESTING).\n\n${task.type}: [${task.id.substring(0,8)}] ${task.title}\nIntent: "${intent}"` }] };
        }

        // Default to checking for IN_PROGRESS if role is generic or unrecognized
        if (inProgressItems.length === 0) {
          return { isError: true, content: [{ type: "text", text: `❌ WORKFLOW BREACH: No task is currently IN_PROGRESS in project [${effectiveProjectId}].` }] };
        }
        
        const defaultTask = itemId ? inProgressItems.find((i: any) => i.id === itemId) : inProgressItems[0];
        if (!defaultTask) return { isError: true, content: [{ type: "text", text: `❌ WORKFLOW BREACH: Specified item is not IN_PROGRESS or does not belong to project [${effectiveProjectId}].` }] };

        return { content: [{ type: "text", text: `✅ WORKFLOW VALIDATED.\n\nActive Item: [${defaultTask.id.substring(0,8)}] ${defaultTask.title}\nProject: [${effectiveProjectId}]\nIntent: "${intent}"` }] };
      }
      case "analyze_request": {
        const { request: userRequest } = z.object({ request: z.string() }).parse(request.params.arguments);
        return { 
          content: [{ 
            type: "text", 
            text: `Complexity analysis for: "${userRequest}"\n\nREMINDER: All work MUST follow these decomposition and inspection rules:\n1. Minimum Decomposition: Every piece of work must be minimally a STORY with child TASKS or an EPIC with child STORIES and their TASKS. Direct coding on a STORY or EPIC without child TASKS is prohibited.\n2. Backlog Inspection: Only items in TODO status should be inspected when starting new work; IDEAs (drafts) must be ignored.\n3. Create ALL sub-items (Stories/Tasks) in TODO status.\n4. PAUSE and ask the user for approval of the plan before moving any item to IN_PROGRESS.` 
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
              content: [{ type: "text", text: `❌ WORKFLOW VIOLATION: Cannot set status to DONE directly from ${currentItem.status}. Move the item to TEST first, then call test_changes(itemId) to run the project's test suite.` }],
            };
          }
          // Allow TEST -> DONE, using verify token to bypass server guard
          const { data } = await api.put(`/items/${id}`, updates, { headers: { 'x-agenfk-internal': VERIFY_TOKEN } });
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        }

        if (updates.status === "REVIEW") {
          return {
            isError: true,
            content: [{ type: "text", text: `❌ WORKFLOW VIOLATION: Cannot set status to REVIEW directly via update_item. Use review_changes(itemId, command) instead.` }],
          };
        }

        const { data } = await api.put(`/items/${id}`, updates);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }
      case "list_items": {
        const { full, ...args } = ListItemsSchema.parse(request.params.arguments || {});
        const { data } = await api.get(`/items`, { params: args });
        
        if (full) {
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        }

        // Return a summarized version to save tokens/avoid truncation
        const summary = (data as any[]).map(item => ({
          id: item.id,
          type: item.type,
          title: item.title,
          status: item.status,
          parentId: item.parentId
        }));

        return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
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
      case "create_branch": {
        const { itemId } = z.object({ itemId: z.string() }).parse(request.params.arguments);
        const { data: item } = await api.get(`/items/${itemId}`);

        if (item.parentId) {
          return { isError: true, content: [{ type: "text", text: `❌ Branches are tracked on top-level items only. Item [${itemId.substring(0, 8)}] is a child of [${item.parentId.substring(0, 8)}]. Run this on the parent item instead.` }] };
        }
        if (item.branchName) {
          // Branch name already assigned — just ensure it exists locally
          try {
            try {
              execSync(`git rev-parse --verify ${item.branchName}`, { stdio: 'ignore' });
            } catch {
              execSync(`git checkout -b ${item.branchName}`, { stdio: 'ignore' });
            }
            execSync(`git checkout ${item.branchName}`, { stdio: 'ignore' });
          } catch (gitErr: any) {
            return { isError: true, content: [{ type: "text", text: `⚠️ Branch '${item.branchName}' is stored on the item but could not be checked out: ${gitErr.message}` }] };
          }
          return { content: [{ type: "text", text: `🔀 Branch '${item.branchName}' already assigned. Switched to it.` }] };
        }

        // Compute branch name
        const prefix = item.type === 'BUG' ? 'fix' : 'feature';
        const slug = item.title.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/[\s]+/g, '-').replace(/-+/g, '-').substring(0, 50).replace(/-$/, '');
        const branchName = `${prefix}/${slug}`;

        try {
          execSync(`git checkout -b ${branchName}`, { stdio: 'ignore' });
        } catch (gitErr: any) {
          return { isError: true, content: [{ type: "text", text: `❌ Failed to create branch '${branchName}': ${gitErr.message}` }] };
        }

        await api.put(`/items/${itemId}`, { branchName });
        return { content: [{ type: "text", text: `🔀 Created and switched to branch '${branchName}'. Stored on item [${itemId.substring(0, 8)}].` }] };
      }
      case "create_pr": {
        const { itemId, description: prBody, draft } = z.object({
          itemId: z.string(),
          description: z.string().optional(),
          draft: z.boolean().optional(),
        }).parse(request.params.arguments);

        // Check gh CLI is available
        try {
          execSync('gh --version', { stdio: 'ignore' });
        } catch {
          return { isError: true, content: [{ type: "text", text: `❌ GitHub CLI (gh) is not installed or not in PATH. Install from https://cli.github.com/` }] };
        }

        const { data: item } = await api.get(`/items/${itemId}`);

        if (item.parentId) {
          return { isError: true, content: [{ type: "text", text: `❌ PRs are tracked on top-level items only. Item [${itemId.substring(0, 8)}] is a child of [${item.parentId.substring(0, 8)}]. Run this on the parent item instead.` }] };
        }
        if (!item.branchName) {
          return { isError: true, content: [{ type: "text", text: `❌ No branch assigned to item [${itemId.substring(0, 8)}]. Create a branch first with the create_branch tool.` }] };
        }
        if (item.prUrl) {
          return { content: [{ type: "text", text: `PR already exists for item [${itemId.substring(0, 8)}]: ${item.prUrl}` }] };
        }

        // Push branch to remote
        try {
          execSync(`git push -u origin ${item.branchName}`, { stdio: 'ignore' });
        } catch (pushErr: any) {
          return { isError: true, content: [{ type: "text", text: `❌ Failed to push branch '${item.branchName}' to remote: ${pushErr.message}` }] };
        }

        // Create PR via gh CLI (spawnSync for safe arg passing)
        const args = ['pr', 'create', '--title', item.title, '--body', prBody || item.description || ''];
        if (draft) args.push('--draft');

        const result = spawnSync('gh', args, { encoding: 'utf8' });
        if (result.status !== 0) {
          return { isError: true, content: [{ type: "text", text: `❌ gh pr create failed:\n${result.stderr || result.stdout}` }] };
        }

        const output = (result.stdout || '').trim();
        const prUrl = output.split('\n').filter(Boolean).pop() || '';
        const prNumberMatch = prUrl.match(/\/pull\/(\d+)$/);
        const prNumber = prNumberMatch ? parseInt(prNumberMatch[1], 10) : undefined;
        const prStatus = draft ? 'draft' : 'open';

        await api.put(`/items/${itemId}`, { prUrl, prNumber, prStatus });

        let msg = `✅ PR created: ${prUrl}`;
        if (prNumber) msg += `\n   PR #${prNumber} linked to item [${itemId.substring(0, 8)}].`;
        msg += `\n\nWhen the PR is approved and merged, run /agenfk-release to create a release.`;
        return { content: [{ type: "text", text: msg }] };
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
