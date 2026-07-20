/**
 * Test helper: connect a real MCP client to the server's MCP `Server` instance
 * over an in-memory transport pair.
 *
 * This lets tests exercise the actual MCP surface (ListTools / CallTool handlers
 * registered in ../../index.ts) through a genuine client round-trip, instead of
 * reading index.ts as a string and grepping for tool names. Importing ../../index
 * is side-effect-free under test because the stdio auto-start there is gated on
 * `require.main === module` (true only for `node dist/index.js`).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { server } from '../../index';

export interface ConnectedMcpClient {
  client: Client;
  close: () => Promise<void>;
}

/** Connect an in-memory MCP client to the shared server instance. */
export async function connectMcpClient(): Promise<ConnectedMcpClient> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await serverTransport.close();
    },
  };
}

/** List the names of every tool the MCP server actually exposes. */
export async function listToolNames(client: Client): Promise<string[]> {
  const { tools } = await client.listTools();
  return tools.map((t) => t.name);
}
