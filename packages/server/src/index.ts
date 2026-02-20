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

const API_URL = process.env.AGENTIC_API_URL || "http://localhost:3000";

const server = new Server(
  {
    name: "agentic-mcp-server",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Define Tool Schemas
const CreateItemSchema = z.object({
  type: z.enum(["EPIC", "STORY", "TASK", "BUG"]),
  title: z.string(),
  description: z.string().optional(),
  parentId: z.string().optional(),
  status: z.enum(["TODO", "IN_PROGRESS", "REVIEW", "DONE", "BLOCKED"]).optional(),
  implementationPlan: z.string().optional(),
});

const UpdateItemSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  status: z.enum(["TODO", "IN_PROGRESS", "REVIEW", "DONE", "BLOCKED"]).optional(),
  implementationPlan: z.string().optional(),
});

const ListItemsSchema = z.object({
  type: z.enum(["EPIC", "STORY", "TASK", "BUG"]).optional(),
  status: z.enum(["TODO", "IN_PROGRESS", "REVIEW", "DONE", "BLOCKED"]).optional(),
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
        name: "create_item",
        description: "Create a new Epic, Story, Task, or Bug in the Agentic framework.",
        inputSchema: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["EPIC", "STORY", "TASK", "BUG"],
              description: "The type of item to create",
            },
            title: {
              type: "string",
              description: "The title of the item",
            },
            description: {
              type: "string",
              description: "Detailed description of the item",
            },
            parentId: {
              type: "string",
              description: "ID of the parent item (e.g., Story ID for a Task)",
            },
            status: {
              type: "string",
              enum: ["TODO", "IN_PROGRESS", "REVIEW", "DONE", "BLOCKED"],
              description: "Initial status (default: TODO)",
            },
            implementationPlan: {
              type: "string",
              description: "Markdown implementation plan (required for Epics)",
            },
          },
          required: ["type", "title"],
        },
      },
      {
        name: "update_item",
        description: "Update an existing item's status, title, or description.",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "The ID of the item to update",
            },
            title: {
              type: "string",
              description: "New title",
            },
            description: {
              type: "string",
              description: "New description",
            },
            status: {
              type: "string",
              enum: ["TODO", "IN_PROGRESS", "REVIEW", "DONE", "BLOCKED"],
              description: "New status",
            },
            implementationPlan: {
              type: "string",
              description: "Updated Markdown implementation plan",
            },
          },
          required: ["id"],
        },
      },
      {
        name: "list_items",
        description: "List items, optionally filtering by type, status, or parent.",
        inputSchema: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["EPIC", "STORY", "TASK", "BUG"],
            },
            status: {
              type: "string",
              enum: ["TODO", "IN_PROGRESS", "REVIEW", "DONE", "BLOCKED"],
            },
            parentId: {
              type: "string",
            },
          },
        },
      },
      {
        name: "get_item",
        description: "Get details of a specific item by ID.",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "The ID of the item",
            },
          },
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
        description: "Get information about the Agentic server.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "workflow_gatekeeper",
        description: "Mandatory pre-flight check before any code change. Verifies that an active task exists.",
        inputSchema: {
          type: "object",
          properties: {
            intent: {
              type: "string",
              description: "The description of what you are about to change in the code.",
            },
          },
          required: ["intent"],
        },
      },
      {
        name: "analyze_request",
        description: "Analyze a user request to suggest the appropriate Agentic item type (Epic, Story, Task, Bug).",
        inputSchema: {
          type: "object",
          properties: {
            request: {
              type: "string",
              description: "The user request or description of work.",
            },
          },
          required: ["request"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
  try {
    switch (request.params.name) {
      case "workflow_gatekeeper": {
        const { intent } = z.object({ intent: z.string() }).parse(request.params.arguments);
        const { data: inProgressItems } = await axios.get(`${API_URL}/items`, { params: { status: "IN_PROGRESS" } });
        
        if (inProgressItems.length === 0) {
          return {
            isError: true,
            content: [{ 
              type: "text", 
              text: `❌ WORKFLOW BREACH: No task is currently IN_PROGRESS. \n\nYou must create a task or move an existing one to IN_PROGRESS before making any code changes. \n\nIntent: "${intent}"` 
            }],
          };
        }

        if (inProgressItems.length > 1) {
          return {
            isError: true,
            content: [{ 
              type: "text", 
              text: `⚠️ AMBIGUOUS WORKFLOW: Multiple tasks are currently IN_PROGRESS. \n\nPlease ensure only one task is active to maintain clear measurability. \n\nActive Tasks:\n${inProgressItems.map((i: any) => `- [${i.id.substring(0,8)}] ${i.title}`).join('\n')}` 
            }],
          };
        }

        const activeTask = inProgressItems[0];
        return {
          content: [{ 
            type: "text", 
            text: `✅ WORKFLOW VALIDATED. \n\nActive Task: [${activeTask.id.substring(0,8)}] ${activeTask.title}\nIntent: "${intent}"\n\nYou are authorized to proceed with the code changes for this specific task.` 
          }],
        };
      }

      case "analyze_request": {
        const { request: userRequest } = z.object({ request: z.string() }).parse(request.params.arguments);
        
        const suggestions = {
          EPIC: "A high-level objective or a large feature set (e.g., 'Add User Profiles'). Requires an Implementation Plan.",
          STORY: "A user-facing functional unit within an Epic (e.g., 'Edit Avatar').",
          TASK: "A technical unit of work or minor change (e.g., 'Update API endpoint').",
          BUG: "A defect or unintended behavior (e.g., 'Avatar not saving')."
        };

        return {
          content: [{
            type: "text",
            text: `Framework Analysis Strategy:\n\n1. If the request is a large feature -> Suggested: EPIC (Ask user for Implementation Plan details if not provided).\n2. If it is a functional unit -> Suggested: STORY.\n3. If it is technical/small -> Suggested: TASK.\n4. If it is a fix -> Suggested: BUG.\n\nUser Request: "${userRequest}"\n\nRecommendation: Based on the scope, select the most appropriate type. If unsure, ask the user for clarification.`
          }]
        };
      }
      case "get_server_info": {
        const { data } = await axios.get(`${API_URL}/`);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                mcp: "agentic-mcp-server",
                api: data,
                api_url: API_URL,
              }, null, 2),
            },
          ],
        };
      }
      case "create_item": {
        const args = CreateItemSchema.parse(request.params.arguments);
        const { data } = await axios.post(`${API_URL}/items`, args);
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      }

      case "update_item": {
        const args = UpdateItemSchema.parse(request.params.arguments);
        const { id, ...updates } = args;
        const { data } = await axios.put(`${API_URL}/items/${id}`, updates);
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      }

      case "list_items": {
        const args = ListItemsSchema.parse(request.params.arguments || {});
        const { data } = await axios.get(`${API_URL}/items`, { params: args });
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      }

      case "get_item": {
        const args = GetItemSchema.parse(request.params.arguments);
        const { data } = await axios.get(`${API_URL}/items/${args.id}`);
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      }

      case "log_token_usage": {
        const args = LogTokenUsageSchema.parse(request.params.arguments);
        const { itemId, ...usage } = args;
        
        // Fetch current item to get usage array
        const { data: item } = await axios.get(`${API_URL}/items/${itemId}`);
        const tokenUsage = item.tokenUsage || [];
        tokenUsage.push(usage);

        const { data: updated } = await axios.put(`${API_URL}/items/${itemId}`, { tokenUsage });
        return {
          content: [{ type: "text", text: "Token usage logged." }],
        };
      }

      case "add_context": {
        const args = AddContextSchema.parse(request.params.arguments);
        const { itemId, ...contextItem } = args;
        
        const { data: item } = await axios.get(`${API_URL}/items/${itemId}`);
        const context = item.context || [];
        context.push({
          id: uuidv4(),
          ...contextItem
        });

        await axios.put(`${API_URL}/items/${itemId}`, { context });
        return {
          content: [{ type: "text", text: "Context added." }],
        };
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
    }
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid arguments: ${error.message}`);
    }
    const message = error.response?.data?.error || error.message;
    throw new McpError(ErrorCode.InternalError, `API Error: ${message}`);
  }
});

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Agentic MCP Server running on stdio (Client Mode)");
}

run().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});
