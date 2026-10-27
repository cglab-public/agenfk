/**
 * AgEnFK Airlock — OpenCode plugin (GH-294).
 *
 * Every tool call that carries a command, a local path or a URL — whatever the
 * tool is called — is judged by the local AgEnFK server through the shared
 * ~/.agenfk/bin/agenfk-airlock.mjs. A deny, or a call that needs a person's
 * approval, is stopped by throwing.
 *
 * OpenCode specifics (@opencode-ai/plugin 1.19.x):
 *   - tool.execute.before(input, output): the arguments are on output.args;
 *     input.args is read too, for older builds;
 *   - the session's model arrives on chat.params (input.model: { id, providerID })
 *     and chat.message (input.model: { providerID, modelID }), keyed by sessionID;
 *   - OpenCode runs every function a plugin module exports as a plugin, so this
 *     file exports only its default.
 *
 * The hooks are async, so the script is imported and awaited in-process: no
 * spawn. When the server cannot answer, the script's decideWhenUnreachable
 * decides: block only when the last-known mode is enforce and the session is
 * covered by the policy.
 *
 * Installed to ~/.config/opencode/plugins/agenfk-airlock.mjs.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

export default async function agenfkAirlock(context) {
    const home = os.homedir();
    const script = path.join(home, '.agenfk', 'bin', 'agenfk-airlock.mjs');
    const stateFile = path.join(home, '.agenfk', 'airlock-state.json');
    /** sessionID -> { provider, id } */
    const models = new Map();
    /** sessionID -> what the server last said for that session's model */
    const lastKnown = new Map();

    let loaded;
    // A failed import is not remembered: a later install makes it work again.
    // The file's mtime rides on the URL, because the runtime caches a module by
    // URL for the life of the process: without it a script deleted or rewritten
    // since (an upgrade, a broken install) would still be served from the cache.
    const load = () => {
        let version;
        try { version = fs.statSync(script).mtimeMs; } catch { return Promise.resolve(null); }
        return import(`${pathToFileURL(script).href}?v=${version}`);
    };
    const airlock = () => (loaded ??= load()
        .then((mod) => { if (!mod) loaded = undefined; return mod; })
        .catch(() => { loaded = undefined; return null; }));

    const remember = (sessionID, provider, id) => {
        const s = text(sessionID);
        if (!s || !text(id)) return;
        models.set(s, { provider: text(provider), id: text(id) });
    };

    return {
        'chat.params': async (input) => {
            try {
                const m = input?.model;
                remember(input?.sessionID, m?.providerID ?? input?.provider?.info?.id, m?.id ?? m?.modelID);
            } catch { /* never break the host */ }
        },

        'chat.message': async (input, output) => {
            try {
                const m = input?.model ?? output?.message?.model;
                remember(input?.sessionID, m?.providerID, m?.modelID ?? m?.id);
            } catch { /* never break the host */ }
        },

        'tool.execute.before': async (input, output) => {
            const args = output?.args || input?.args || {};
            const sessionID = text(input?.sessionID);
            const model = (sessionID && models.get(sessionID)) || null;
            const modelKey = model ? `${model.provider ?? ''}/${model.id ?? ''}` : '';
            const session = { client: 'opencode', model };

            const mod = await airlock();
            if (!mod) {
                // The shared script is missing: the install is broken. Without it
                // the policy cannot be read in full, so refuse a call that
                // carries anything Airlock judges only while the policy enforces.
                const carries = ['command', 'cmd', 'commands', 'path', 'file_path', 'filePath', 'notebook_path', 'paths', 'url', 'uri', 'href']
                    .some((k) => args[k] !== undefined && args[k] !== null && args[k] !== '');
                let mode;
                try { mode = JSON.parse(fs.readFileSync(stateFile, 'utf8'))?.mode; } catch { mode = undefined; }
                if (carries && mode === 'enforce') {
                    throw new Error(`[agenfk airlock] ${script} is missing, and the Airlock policy enforces, so this tool call is refused. Reinstall AgEnFK (agenfk upgrade).`);
                }
                return;
            }
            if (!mod.hasCapabilities(args)) return;

            const result = await mod.requestVerdict({
                client: 'opencode',
                model,
                toolName: String(input?.tool ?? ''),
                args,
                ...(sessionID ? { sessionId: sessionID } : {}),
                ...(text(context?.directory) ? { cwd: context.directory } : {}),
            });

            if (result?.status === 'ok' && result.verdict) {
                if (sessionID) {
                    lastKnown.set(sessionID, {
                        mode: String(result.mode), applies: result.applies === true,
                        revision: result.revision, source: result.source, at: Date.now(), modelKey,
                    });
                }
                const message = mod.blockMessage(result.verdict);
                if (message) throw new Error(message);
                return;
            }

            // The last answer counts only for the model it was given for.
            const known = sessionID ? lastKnown.get(sessionID) : undefined;
            const fallback = mod.decideWhenUnreachable(known && known.modelKey === modelKey ? known : null, stateFile, session);
            if (fallback.block) throw new Error(fallback.reason);
        },
    };
}
