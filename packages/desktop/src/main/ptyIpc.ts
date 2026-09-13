/**
 * The IPC surface for terminals (CGLAB-169).
 *
 * This is the border. Everything on the renderer side of it is untrusted —
 * the renderer runs the same bundle a browser would, so an XSS in it speaks
 * through these channels with the user's credentials.
 *
 * Three rules shape every handler here:
 *
 *  - The renderer names an ITEM and an AGENT, never a path and never a command.
 *    The worktree comes from the server, the executable from the closed set in
 *    agents.ts.
 *  - Every call is attributed to the window that made it, taken from the
 *    event's own sender — never from the payload, which the renderer controls.
 *    Ownership is worthless if the caller can claim to be another window.
 *  - Arguments are validated before use. `ipcMain.handle` hands over whatever
 *    was serialised, including objects, `undefined`, and numbers where strings
 *    were expected.
 *
 * Registration is a separate function from the registry itself so the rules
 * above are unit-testable without Electron.
 */
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { PtyRegistry } from './ptyRegistry.js';
import { detectAgents, __resetAgentDetectionCache } from './detectAgents.js';

/** Minimal shape of `ipcMain` so tests need no Electron. */
export interface IpcLike {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void;
}

const asString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value;
};

const asSize = (value: unknown, field: string): number => {
  // Bounded, not merely numeric: node-pty passes these to ioctl, and a
  // negative or absurd value is at best a broken terminal.
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 5000) {
    throw new Error(`${field} must be an integer between 1 and 5000.`);
  }
  return value;
};

/**
 * The window that actually sent the message.
 *
 * Deliberately derived from the event rather than accepted as a parameter: a
 * renderer that could state its own window id could address another window's
 * sessions, which is the entire thing ownership exists to stop.
 */
export const senderWindowId = (event: { sender: Pick<WebContents, 'id'> }): number => event.sender.id;

export function registerPtyIpc(registry: PtyRegistry, ipc: IpcLike = ipcMain): void {
  ipc.handle('pty:spawn', async (event, raw) => {
    const req = (raw ?? {}) as Record<string, unknown>;
    return registry.spawn({
      itemId: asString(req.itemId, 'itemId'),
      agentId: asString(req.agentId, 'agentId'),
      windowId: senderWindowId(event),
      cols: asSize(req.cols, 'cols'),
      rows: asSize(req.rows, 'rows'),
      // Strict === true, not truthiness. This disables the agent's own safety
      // prompts, so a stray string, a 1, or an object must not be enough.
      autoApprove: req.autoApprove === true,
    });
  });

  ipc.handle('pty:write', (event, raw) => {
    const req = (raw ?? {}) as Record<string, unknown>;
    registry.write(asString(req.sessionId, 'sessionId'), senderWindowId(event), asString(req.data, 'data'));
    return true;
  });

  ipc.handle('pty:resize', (event, raw) => {
    const req = (raw ?? {}) as Record<string, unknown>;
    registry.resize(
      asString(req.sessionId, 'sessionId'),
      senderWindowId(event),
      asSize(req.cols, 'cols'),
      asSize(req.rows, 'rows'),
    );
    return true;
  });

  ipc.handle('pty:kill', (event, raw) => {
    const req = (raw ?? {}) as Record<string, unknown>;
    registry.kill(asString(req.sessionId, 'sessionId'), senderWindowId(event));
    return true;
  });

  // Read-only: the list of agents and whether each is installed. Nothing here
  // takes renderer input, because the set of things to probe is closed.
  ipc.handle('agents:list', async () => detectAgents());

  // After the user installs a CLI, so the picker updates without an app
  // restart. Also takes no input.
  ipc.handle('agents:refresh', async () => {
    __resetAgentDetectionCache();
    return detectAgents();
  });
}
