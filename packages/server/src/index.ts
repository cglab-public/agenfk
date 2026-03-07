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
import { toToon } from "@agenfk/core";
import { execSync, spawnSync, spawn } from "child_process";
import { getActiveStepItems } from "./gatekeeper-utils";

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
  status: z.enum(["TODO", "IN_PROGRESS", "TEST", "REVIEW", "DONE", "BLOCKED", "PAUSED"]).optional(),
  implementationPlan: z.string().optional(),
});

const UpdateItemSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  status: z.enum(["TODO", "IN_PROGRESS", "TEST", "REVIEW", "DONE", "BLOCKED", "PAUSED"]).optional(),
  type: z.enum(["EPIC", "STORY", "TASK", "BUG"]).optional(),
  implementationPlan: z.string().optional(),
});

const ListItemsSchema = z.object({
  projectId: z.string(),
  type: z.enum(["EPIC", "STORY", "TASK", "BUG"]).optional(),
  status: z.enum(["TODO", "IN_PROGRESS", "TEST", "REVIEW", "DONE", "BLOCKED", "PAUSED"]),
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
        description: "List all existing AgEnFK projects.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "create_project",
        description: "Create a new AgEnFK project.",
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
        description: "Create a new Epic, Story, Task, or Bug in the AgEnFK framework.",
        inputSchema: {
          type: "object",
          properties: {
            projectId: { type: "string" },
            type: { type: "string", enum: ["EPIC", "STORY", "TASK", "BUG"] },
            title: { type: "string" },
            description: { type: "string" },
            parentId: { type: "string" },
            status: { type: "string", enum: ["TODO", "IN_PROGRESS", "TEST", "REVIEW", "DONE", "BLOCKED", "PAUSED"] },
            implementationPlan: { type: "string" },
          },
          required: ["projectId", "type", "title"],
        },
      },
      {
        name: "update_item",
        description: "Update an existing item's status, title, or description. IMPORTANT: Cannot set status to DONE directly — use test_changes.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            description: { type: "string" },
            status: { type: "string", enum: ["TODO", "IN_PROGRESS", "TEST", "REVIEW", "DONE", "BLOCKED", "PAUSED"] },
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
            status: { type: "string", enum: ["TODO", "IN_PROGRESS", "TEST", "REVIEW", "DONE", "BLOCKED", "PAUSED"] },
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
        description: "Get information about the AgEnFK server.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "workflow_gatekeeper",
        description: "Mandatory pre-flight check before any code change. Verifies that an active task exists in any working flow step and returns context (exit criteria, flow steps, branch). role= is accepted for backward compatibility but is no longer enforced.",
        inputSchema: {
          type: "object",
          properties: {
            intent: { type: "string" },
            role: { type: "string", enum: ["planning", "coding", "validating", "review", "testing", "closing"], description: "Optional: accepted for backward compatibility but no longer enforced." },
            itemId: { type: "string", description: "Optional: The specific item ID to authorize against. Required if multiple tasks are active simultaneously." }
          },
          required: ["intent"],
        },
      },
      {
        name: "analyze_request",
        description: "Analyze a user request to suggest the appropriate AgEnFK item type.",
        inputSchema: {
          type: "object",
          properties: { request: { type: "string" } },
          required: ["request"],
        },
      },
      {
        name: "validate_progress",
        description: "Validates exit criteria for the current flow step and advances the item to the next step. If command is provided, runs it as a build/test gate. If omitted, uses the project's verifyCommand. On success, advances to the next flow step (or DONE if last). On failure, moves back to the coding step. Call workflow_gatekeeper(role='validating') first — the response includes the current step's exit criteria.",
        inputSchema: {
          type: "object",
          properties: {
            itemId: { type: "string" },
            command: { type: "string", description: "Optional command to run (e.g. 'npm run build'). If omitted, the project verifyCommand is used." },
          },
          required: ["itemId"],
        },
      },
      {
        name: "review_changes",
        description: "DEPRECATED: Use validate_progress instead. Runs a build command and advances to the next flow step.",
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
        description: "DEPRECATED: Use validate_progress instead. Runs the project's verifyCommand and advances to the next flow step.",
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
      {
        name: "move_item",
        description: "Move an item and all its children recursively to a different project.",
        inputSchema: {
          type: "object",
          properties: {
            itemId: { type: "string", description: "The ID of the item to move." },
            targetProjectId: { type: "string", description: "The ID of the destination project." },
          },
          required: ["itemId", "targetProjectId"],
        },
      },
      {
        name: "pause_work",
        description: "Pause work on an item, saving a snapshot of the current context so another agent can resume later. Sets the item to PAUSED status.",
        inputSchema: {
          type: "object",
          properties: {
            itemId: { type: "string" },
            summary: { type: "string", description: "Summary of work done and what remains." },
            filesModified: { type: "array", items: { type: "string" }, description: "List of files modified during this session." },
            resumeInstructions: { type: "string", description: "Step-by-step instructions for the next agent to pick up where you left off." },
            gitDiff: { type: "string", description: "Optional condensed git diff of uncommitted changes." },
          },
          required: ["itemId", "summary", "resumeInstructions"],
        },
      },
      {
        name: "resume_work",
        description: "Resume work on a paused item. Retrieves the pause snapshot with full context (summary, files modified, resume instructions, git diff) and restores the item to its pre-pause status.",
        inputSchema: {
          type: "object",
          properties: {
            itemId: { type: "string" },
          },
          required: ["itemId"],
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
        return { content: [{ type: "text", text: toToon(data) }] };
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
      case "validate_progress": {
        const { itemId, command } = z.object({ itemId: z.string(), command: z.string().optional() }).parse(request.params.arguments);
        try {
          const { data } = await api.post(`/items/${itemId}/validate`, { command }, { headers: { 'x-agenfk-internal': VERIFY_TOKEN } });
          return { content: [{ type: "text", text: data.message }] };
        } catch (error: any) {
          const msg = error.response?.data?.message || error.response?.data?.error || error.message;
          return { isError: true, content: [{ type: "text", text: msg }] };
        }
      }
      case "review_changes": {
        const { itemId, command } = z.object({ itemId: z.string(), command: z.string() }).parse(request.params.arguments);
        try {
          const { data } = await api.post(`/items/${itemId}/validate`, { command }, { headers: { 'x-agenfk-internal': VERIFY_TOKEN } });
          return { content: [{ type: "text", text: `[DEPRECATED: use validate_progress] ${data.message}` }] };
        } catch (error: any) {
          const msg = error.response?.data?.message || error.response?.data?.error || error.message;
          return { isError: true, content: [{ type: "text", text: msg }] };
        }
      }
      case "test_changes": {
        const { itemId } = z.object({ itemId: z.string() }).parse(request.params.arguments);
        try {
          const { data } = await api.post(`/items/${itemId}/validate`, {}, { headers: { 'x-agenfk-internal': VERIFY_TOKEN } });
          return { content: [{ type: "text", text: `[DEPRECATED: use validate_progress] ${data.message}` }] };
        } catch (error: any) {
          const msg = error.response?.data?.message || error.response?.data?.error || error.message;
          return { isError: true, content: [{ type: "text", text: msg }] };
        }
      }
      case "workflow_gatekeeper": {
        const { intent, role, itemId } = z.object({
          intent: z.string(),
          role: z.enum(["planning", "coding", "validating", "review", "testing", "closing"]).optional(),
          itemId: z.string().optional()
        }).parse(request.params.arguments);

        // Resolve the effective Project ID
        let effectiveProjectId: string | undefined | null;

        if (itemId) {
          try {
            const { data: item } = await api.get(`/items/${itemId}`);
            effectiveProjectId = item.projectId;
          } catch (error: any) {
            return { isError: true, content: [{ type: "text", text: `❌ CONFIG ERROR: Item [${itemId}] not found in database.` }] };
          }
        } else {
          effectiveProjectId = findProjectId(process.cwd());
        }

        if (!effectiveProjectId) {
          return { isError: true, content: [{ type: "text", text: `❌ CONFIG ERROR: No AgEnFK project found in the current directory, and no itemId was provided.` }] };
        }

        // Validate that the project exists in the database
        try {
          await api.get(`/projects/${effectiveProjectId}`);
        } catch (error: any) {
          return { isError: true, content: [{ type: "text", text: `❌ CONFIG ERROR: Project ID [${effectiveProjectId}] does not exist in the database.` }] };
        }

        // Fetch items and active flow for project
        const [{ data: allItems }, { data: activeFlow }] = await Promise.all([
          api.get(`/items`, { params: { projectId: effectiveProjectId } }),
          api.get(`/projects/${effectiveProjectId}/flow`).catch(() => ({ data: null })),
        ]);

        // Build flow steps summary
        const sortedFlowSteps: any[] = activeFlow
          ? [...activeFlow.steps].sort((a: any, b: any) => a.order - b.order)
          : [];
        const flowStepsSummary = activeFlow
          ? `\nActive Flow: "${activeFlow.name}" — Steps: ${sortedFlowSteps.map((s: any) => s.name).join(' → ')}`
          : '';

        // Find all items in any active working step (any non-anchor, non-BLOCKED/PAUSED step)
        const workingItems = getActiveStepItems(allItems, activeFlow);
        const actionableItems = workingItems.filter((i: any) => i.type === 'TASK' || i.type === 'BUG');

        if (actionableItems.length === 0) {
          return { isError: true, content: [{ type: "text", text: `❌ WORKFLOW BREACH: No task is currently active in project [${effectiveProjectId}]. Advance a task from TODO first.${flowStepsSummary}` }] };
        }

        // Resolve which task to authorize
        let task: any;
        if (itemId) {
          task = workingItems.find((i: any) => i.id === itemId);
          if (!task) return { isError: true, content: [{ type: "text", text: `❌ WORKFLOW BREACH: Item [${itemId}] is not in an active working step or does not belong to project [${effectiveProjectId}].` }] };
          if (task.type === 'EPIC' || task.type === 'STORY') {
            return { isError: true, content: [{ type: "text", text: `❌ WORKFLOW BREACH: Cannot authorize work directly on a ${task.type}. Please decompose into TASKS and work on those instead.` }] };
          }
        } else {
          if (actionableItems.length > 1) {
            const list = actionableItems.map((i: any) => `  • [${i.id.substring(0,8)}] ${i.title} (${i.status})`).join('\n');
            return { isError: true, content: [{ type: "text", text: `⚠️ AMBIGUOUS WORKFLOW: Multiple tasks are active in project [${effectiveProjectId}]. Provide 'itemId' to disambiguate:\n${list}` }] };
          }
          task = actionableItems[0];
        }

        // Surface exit criteria for the current step
        const currentStep = sortedFlowSteps.find((s: any) => s.name.toUpperCase() === task.status.toUpperCase());
        const exitCriteriaHint = currentStep?.exitCriteria
          ? `\nExit criteria: "${currentStep.exitCriteria}"\n→ Satisfy the above before calling validate_progress.`
          : '\n→ Call validate_progress(itemId, command?) to advance to the next step.';

        // Branch hint
        let branchHint = '';
        if (task.branchName) {
          try {
            execSync(`git rev-parse --verify ${task.branchName}`, { stdio: 'ignore' });
            const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
            if (currentBranch !== task.branchName) {
              execSync(`git checkout ${task.branchName}`, { stdio: 'ignore' });
              branchHint = `\n🔀 Switched to branch '${task.branchName}'.`;
            } else {
              branchHint = `\n🔀 Already on branch '${task.branchName}'.`;
            }
          } catch {
            branchHint = `\n⚠️ Branch '${task.branchName}' does not exist locally. Create and check out this branch before writing code.`;
          }
        }

        return { content: [{ type: "text", text: `✅ AUTHORIZED.\n\n${task.type}: [${task.id.substring(0,8)}] ${task.title}\nCurrent step: ${task.status}\nIntent: "${intent}"${branchHint}${exitCriteriaHint}${flowStepsSummary}` }] };
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

        // Enforce workflow: block direct transitions to DONE — must use test_changes
        if (updates.status === "DONE") {
          // Fetch active flow to determine valid pre-DONE steps
          let preDoneSteps = new Set(['IN_PROGRESS', 'REVIEW', 'TEST']);
          try {
            const { data: itemFlow } = await api.get(`/projects/${currentItem.projectId}/flow`).catch(() => ({ data: null }));
            if (itemFlow?.steps) {
              preDoneSteps = new Set(itemFlow.steps.filter((s: any) => !s.isAnchor).map((s: any) => (s.name as string).toUpperCase()));
            }
          } catch { /* use defaults */ }
          if (!preDoneSteps.has(currentItem.status.toUpperCase())) {
            return {
              isError: true,
              content: [{ type: "text", text: `❌ WORKFLOW VIOLATION: Cannot set status to DONE directly from ${currentItem.status}. Use test_changes(itemId) to run the project's test suite and advance to DONE.` }],
            };
          }
          // Allow TEST -> DONE, using verify token to bypass server guard
          const { data } = await api.put(`/items/${id}`, updates, { headers: { 'x-agenfk-internal': VERIFY_TOKEN } });
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        }

        const { data } = await api.put(`/items/${id}`, updates);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }
      case "list_items": {
        const { full, ...args } = ListItemsSchema.parse(request.params.arguments || {});
        const { data } = await api.get(`/items`, { params: args });
        
        if (full) {
          return { content: [{ type: "text", text: toToon(data) }] };
        }

        // Return a summarized version to save tokens/avoid truncation
        const summary = (data as any[]).map(item => ({
          id: item.id,
          type: item.type,
          title: item.title,
          status: item.status,
          parentId: item.parentId
        }));

        return { content: [{ type: "text", text: toToon(summary) }] };
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
      case "move_item": {
        const { itemId, targetProjectId } = z.object({
          itemId: z.string(),
          targetProjectId: z.string(),
        }).parse(request.params.arguments);
        try {
          const { data } = await api.post(`/items/${itemId}/move`, { targetProjectId });
          return {
            content: [{
              type: "text",
              text: `✅ Moved "${data.item.title}" and ${data.movedCount - 1} child item(s) to project [${targetProjectId}]. Total moved: ${data.movedCount}.`
            }]
          };
        } catch (error: any) {
          const msg = error.response?.data?.error || error.message;
          return { isError: true, content: [{ type: "text", text: `❌ Failed to move item: ${msg}` }] };
        }
      }
      case "pause_work": {
        const { itemId, summary, filesModified, resumeInstructions, gitDiff } = z.object({
          itemId: z.string(),
          summary: z.string(),
          filesModified: z.array(z.string()).optional(),
          resumeInstructions: z.string(),
          gitDiff: z.string().optional(),
        }).parse(request.params.arguments);
        try {
          const { data } = await api.post(`/items/${itemId}/pause`, { summary, filesModified, resumeInstructions, gitDiff });
          return { content: [{ type: "text", text: `⏸️ Work paused on item [${itemId.substring(0, 8)}].\n\nSnapshot ID: ${data.id}\nPrevious status: ${data.status}\n\nThe item is now in PAUSED status. Use resume_work(itemId) to continue later.` }] };
        } catch (error: any) {
          const msg = error.response?.data?.error || error.message;
          return { isError: true, content: [{ type: "text", text: `❌ Failed to pause: ${msg}` }] };
        }
      }
      case "resume_work": {
        const { itemId } = z.object({ itemId: z.string() }).parse(request.params.arguments);
        try {
          const { data } = await api.post(`/items/${itemId}/resume`);
          const snapshot = data.snapshot;
          const item = data.item;
          let text = `▶️ Work resumed on item [${itemId.substring(0, 8)}] — ${item.title}\n\n`;
          text += `**Restored status**: ${snapshot.status}\n`;
          if (snapshot.branchName) text += `**Branch**: ${snapshot.branchName}\n`;
          text += `\n## Summary of previous work\n${snapshot.summary}\n`;
          text += `\n## Resume instructions\n${snapshot.resumeInstructions}\n`;
          if (snapshot.filesModified?.length) {
            text += `\n## Files modified\n${snapshot.filesModified.map((f: string) => `- ${f}`).join('\n')}\n`;
          }
          if (snapshot.gitDiff) {
            text += `\n## Git diff (at pause time)\n\`\`\`\n${snapshot.gitDiff}\n\`\`\`\n`;
          }
          return { content: [{ type: "text", text }] };
        } catch (error: any) {
          const msg = error.response?.data?.error || error.message;
          return { isError: true, content: [{ type: "text", text: `❌ Failed to resume: ${msg}` }] };
        }
      }
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
    }
  } catch (error: any) {
    let errorMessage = error.message;
    if (error.response) errorMessage = `API Error (${error.response.status}): ${JSON.stringify(error.response.data)}`;
    else if (error.code === 'ECONNREFUSED') errorMessage = `Could not connect to AgEnFK API at ${API_URL}.`;
    return { content: [{ type: "text", text: `❌ Error: ${errorMessage}` }], isError: true };
  }
});

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("AgEnFK MCP Server running on stdio (Client Mode)");
}

run().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});
