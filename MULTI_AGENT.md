# Multiple agents, one worktree

Reference for how this project runs several agents at once, why it stopped
trying to give each one its own checkout, and what keeps them from destroying
each other's work. Written 2026-09-15 from a study of Orca (`~/GitHub/orca`,
read-only) plus measurements taken on this repository.

This is the durable half of two artifacts — *The Fleet That Cannot Run* and
*Work Without a Window* — and of about fifteen cards. If the two disagree with
each other, this file is the one that was checked in.

---

## The decision

**Several agents share one worktree. The collision control is a claim, not
isolation.**

The earlier answer was the opposite — a branch and a worktree per child — and
it was withdrawn in full. Two things killed it.

**Git refuses.** `shouldAutoWorktree` (`packages/server/src/server.ts`) returns
false for any item carrying a `parentId`, with the stated reason that a child
shares its parent's branch by design. `SDLC.md` agrees, three CLI refusals
agree, a pinning test agrees, and git itself will not check one branch out into
two worktrees. So the exact decomposition `SKILL.md` tells an agent to perform —
break the work into children and run them — lands precisely on the set of items
that share one branch.

**The most mature product in this space recommends the opposite of isolation.**
Orca's orchestration guide, `skill-guides/orchestration/references/placement-and-remote.md`:

> A fresh worker means a fresh agent terminal, **not a new Git worktree**. Use
> the current or an exact existing workspace by default. Create a worktree only
> when the user requested one or a concrete checkout or filesystem conflict
> makes sharing unsafe.

Their documented fan-out runs `worker-start --worktree current` for every
worker. Sharing one tree is the recommended path there, not the exception.

### What sharing actually costs

Two agents editing one file in one tree is a **race, not a merge conflict**.
Nobody is told, and the loser's edit is gone. Separate worktrees would have made
it something a person has to resolve; one shared tree makes it silent. That is
the whole reason the claims mechanism exists.

### Why not just give each agent a real copy

`node_modules` in this repo is 939 MB against 8.1 MB of source. Three ways
around it were examined and the measurement matters more than the summary:

- **Symlink the directory** (what Orca's `worktree.sharedDirectories` does, in
  `src/main/ipc/worktree-symlinks.ts`: *"share mode must never clone — an
  independent copy would give each worktree its own node_modules, defeating
  one-install-serves-all"*). In a workspace monorepo this is a **trap**:
  `node_modules/@agenfk/core` is a *relative* symlink into `packages/`, so every
  `@agenfk/*` import resolves back to the PRIMARY checkout. The suite goes green
  having tested the wrong code.
- **APFS clone-copy** (`cp -c`, copy-on-write, near-zero disk). Reproduced here
  with Orca's own invocation: the cloned tree's relative `@scope/pkg` link
  resolves **in-tree**; the symlinked tree resolves to the primary checkout. So
  the fourth option is real and works — and nobody ships it for dependency
  trees. Orca explicitly refuses to: `worktree-include-copy-budget.ts` caps a
  per-worktree copy at 2 GB / 50,000 entries specifically to *"refuse dependency
  trees"*, and refuses **before the first byte** because `fs.cp` ignores its
  `signal` option and a started copy cannot be cancelled.
- **Install per worktree.** What Orca's own `orca.yaml` actually does — it
  declares no `sharedDirectories` at all and runs `pnpm install` via
  `scripts.setup`. Tracked here as card `cada336b`.

`pnpm` does not rescue anyone: its store links stay inside `node_modules`, but a
`workspace:*` link escapes exactly as npm's does. Orca declares five such links;
this repo is an npm workspace pinning exact versions, and its eight
`node_modules/@agenfk/*` entries are symlinks into `packages/` all the same.

---

## Claims

A claim is the list of paths a card owns while it is being worked. It is the
only thing standing between two agents and one file.

| Layer | Where | What it does |
| --- | --- | --- |
| Overlap logic | `packages/core/src/claims.ts` | Can these two paths collide? Pure. |
| The gate | `packages/core/src/claimGate.ts` | Turns an overlap into a refusal. Pure. |
| Pre-edit check | `packages/core/src/gatekeeper.ts` | Refuses to AUTHORIZE a card whose declared claims run into another card's. CLI and server inherit one verdict. It does not see the file being written. |
| Mechanical block | `bin/agenfk-gatekeeper.mjs` | The PreToolUse hook. Refuses an edit to a file held by a PARKED card (TODO/PAUSED/BLOCKED). **Cannot** refuse when the holder is active: it receives a tool call, not an agent identity. |
| Declaration | `PUT /items/:id` (`packages/server/src/server.ts`) | Validates, refuses a glob, refuses a claim another card holds (409). |
| Close | `packages/server/src/closeCommit.ts` | Commits only the closing card's files out of the shared index. |

### Two failure directions, and both are silent

**Failing open** is the one that loses work: reporting "no conflict" when there
is one. `claims.ts` had it four separate times, each found by review, each a
pair that obviously overlaps reported as clear — a backslash separator, a
doubled slash, a trailing-slash convention, and a malformed claim silently
dropped. The lesson written into that module: *a claim that cannot be checked is
worse than no claim, because it reports safety it has not established.*

**Blocking everything** is the one that stops the project. Every card in the
database predates the field, so a gate reading absence as conflict refuses the
first edit anybody makes after it ships. **Absence authorizes.**

### Claims are not globs

The obvious design is `packages/ui/**` and a matcher. The question here is not
"does this path match this pattern" — it is "can these two patterns ever match
the same path", which is a different and much harder problem. So the input is
constrained to two shapes where overlap is exact (a directory, or an exact
file), and anything else is **reported as rejected** rather than quietly
skipped. A glob compared as a literal is a claim on a file named `**`: it
protects nothing while looking like it protects everything.

### A paused card still holds its files

`RELEASED_STATUSES` in `claimGate.ts` is deliberately **not**
`INACTIVE_STATUSES` from the gatekeeper, and reusing it is the obvious mistake.
That set answers "is this card working", which includes `PAUSED`. This one
answers "are its files finished with" — and a paused card's are the opposite of
finished: half-edited, lying in the shared tree, with the agent finding out on
resume. Terminal statuses release, and so does IDEAS - an idea has never been worked, so it holds nothing. Note this list is a fixed set of NAMES, and a flow authored by `agenfk flow create` rarely calls its final step DONE; on such a flow a finished card holds its claims forever. Tracked as a defect.

---

## Staging is the other half

The close commit was `git add -A && git commit` in the project root for seven
months. It was correct when written — one tree, one session — and became wrong
when worktrees arrived without anyone revisiting it. Not a bug: an expired
premise.

It now commits **the index**, limited to the card's claims when it has any.

**Every agent stages only what its card changed.** `.git/index` belongs to the
worktree, not to an agent, so a bare `git commit` still takes whatever any of
them staged — narrower than `add -A`, and not isolation. The pathspec is what
makes it true. Staging nothing commits nothing, on purpose: "nothing staged, so
stage everything" is the original defect with a condition in front of it, and it
would fire precisely when an agent had been careful.

### This has been exercised, once

On 2026-09-15 three agents worked this tree simultaneously. The index held two
cards' work before either closed; one agent noticed and said so; the split was
done by hand into two commits and nobody's work was swept. Four commits, three
agents, zero sweeps.

What kept them apart was **staging discipline, not claims** — no card in the
database has ever declared one. The mechanism is complete, tested end to end,
and dormant, because the rules installed on a user's machine never mention that
it exists (card `90fd9d32`).

---

## Taken from Orca

Verified against the checkout with file:line; the cards are children of epic
`998fa96c`.

- **Session state vocabulary** — `live` / `unverifiable` / `exited`, with the
  rule that *loss of contact is not evidence of `exited`*. Never collapse
  `unverifiable` into either neighbour. (`docs/reference/ssh-execution-boundary.md`)
- **Measure before copying, refuse before the first byte.** See the budget
  above. A half-copied tree cannot be reasoned about.
- **A staleness gate at dispatch** — `DISPATCH_STALE_THRESHOLD = 20` commits
  behind base. It is a *skip*, not a refusal, and the BASE DRIFT block reaches
  the worker whenever it is behind at all, not only when overridden.
- **Next action as data.** `projectFleetNextAction` returns a literal argv per
  worker, emitted on `worker-list` rows. **Nothing in main executes it.** The
  cleanest expression of the whole posture: compute the right move, show the
  command, wait.
- **Warn-only stall detection**, 10 min = heartbeat cadence × 2, with the reason
  in the code: *a false positive (slow but correct worker) costs more than a
  false negative (hung worker holding a slot)*. There is no task-execution
  timeout anywhere in their product.
- **A three-strike circuit breaker** with a stated no-workaround rule: do not
  route around it with a new Run or an unrelated Dispatch.
- **Two rules worth copying verbatim** — *absence never authorizes stop,
  abandon, retry, or release*; and *if `worker-start` exits non-zero, do not
  relaunch*.

## Deliberately not taken

Orca launches every agent with its permission-bypass flag pre-applied by
default — `--dangerously-skip-permissions`, `--yolo`, and the equivalent for
each supported CLI — and says in the same documentation that *a worktree is an
isolated checkout, not a security sandbox*. The trade is theirs to make. It is
recorded here so nobody re-proposes it as an oversight.

## Where Orca is behind

In shared-worktree mode — their recommended default — there is no file locking,
no ownership record, no planning-time partitioning, and no post-hoc overlap
check between two workers. The only thing between two agents and one file is a
prose sentence addressed to the coordinating model, plus a task-spec convention
asking each spec to state what it may edit. That is claims, written in English
and enforced by nobody.

Also worth knowing before copying their model: their built-in `Coordinator`
class does not decompose at all (`coordinator.ts` carries the comment
*"decomposition isn't implemented yet"*, and the RPC that drove it is documented
as retired), and the README's "fan one prompt across five agents" is a **manual
human flow** with no code implementing it. Their racing feature and their
orchestration feature are unrelated code paths.

## Where this project is behind

Scheduled automations that create a worktree and run an agent unattended with no
window open (`7dd8802b`), and the Run / Task / Dispatch model with a coordinator
inbox (`66964b72`). Their decision gates are weaker than they look and should
not be copied as-is: `gateResolve` resolves run scope with
`requireCurrentConsumer: true`, so the authorized caller *is* the coordinator
terminal, and no human gate UI exists in their renderer.

---

## Open, and in order

1. `90fd9d32` — the installed rules never mention claims, so nobody declares
   one. Small, and it is what takes the mechanism out of dormancy.
2. `0c3211ab` — fan-out in one tree, with claims checked before dispatch.
3. `cada336b` — install dependencies per worktree via a setup script.
4. The twelve children of `998fa96c` — the Orca reuse list above.

## The shape to watch for

Three features this week were **complete on both ends and disconnected in the
middle**: `closeCommit` accepted a claims pathspec no caller passed; the item
route dropped a `claims` field because it destructures an allowlist; agent runs
have a reader and a writer that nobody joined. Each was invisible for the same
reason — a feature never exercised end to end reports success at every layer it
has.
