/**
 * efcacdeb (C4) — a person's approval of a command check's exact command,
 * signed with a passkey on the board. The server pins it by the same hash:
 * sha256 of the argv's JSON, so a changed command asks again.
 */
import axios from 'axios';
import { API_URL } from './apiUrl';

/** What the approval pins: sha256 of the argv's JSON, as the server computes it. */
export async function argvHash(argv: readonly string[]): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(argv)));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Record the approval: the board header, and the passkey assertion over exactly this command. */
export async function approveCommand(projectId: string, argv: readonly string[], assertion: unknown) {
  const { data } = await axios.post(`${API_URL}/projects/${projectId}/command-approvals`, { argv, assertion }, { headers: { 'x-agenfk-ui': '1' } });
  return data;
}
