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

**Several agents share one worktree. What keeps them apart is staging
discipline, not isolation.**

Claims - a per-card list of owned paths, enforced at the edit, at declaration
and at the close commit - were built on top of this and then removed
(26c059f6). They locked the parallel work they were meant to protect: two
agents could not change different regions of one file, which a person does
every day, and the refusals fired on the very work they guarded. Do not bring
them back as a fix for a sweep; the close commits only what was staged.

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
why every agent stages only its own card's files, and why the close never
sweeps the tree.

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

## Staging is the control

The close commit was `git add -A && git commit` in the project root for seven
months. It was correct when written — one tree, one session — and became wrong
when worktrees arrived without anyone revisiting it. Not a bug: an expired
premise.

It now commits **the index**, and stages nothing itself.

**Every agent stages only what its card changed.** `.git/index` belongs to the
worktree, not to an agent, so a bare `git commit` still takes whatever any of
them staged — narrower than `add -A`, and not isolation: each agent's own
`git add` is what makes it true. Staging nothing commits nothing, on purpose: "nothing staged, so
stage everything" is the original defect with a condition in front of it, and it
would fire precisely when an agent had been careful.

### What went with claims

The check engine used to leave out of a card's change the files and tests that
another active card claimed (5b48b96b). That exclusion was part of claims and
went with them: every change in the tree is now the card's own. In one shared
tree a sibling's red test fails this card's `suite-green`, a sibling's deleted
test fails `test-count-not-lower`, a sibling's source file fails
`only-test-files-changed` on a tests-only step, and a sibling's dirty file fails
`tree-clean`. A fan-out in one tree therefore needs timing as well as staging
discipline: siblings whose work is red or half-written should not be verifying
at the same moment. This is a known cost of the removal, not a defect to fix by
bringing claims back.

### This has been exercised, once

On 2026-09-15 three agents worked this tree simultaneously. The index held two
cards' work before either closed; one agent noticed and said so; the split was
done by hand into two commits and nobody's work was swept. Four commits, three
agents, zero sweeps.

What kept them apart was **staging discipline**, and nothing else.

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

Worth knowing before copying their model: their built-in `Coordinator`
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

## What the interface has to show

The figures of *The Fleet That Cannot Run* specify the screen, and they are
recorded here because that artifact is a page and this file is the thing that
survives. None of it is worth anything if nothing on screen says it is
working.

| What | Where | State |
| --- | --- | --- |
| A state dot per session on the tab strip, failed and blocked coloured | `packages/ui/src/tabState.ts` | **shipped** |
| `N need you`, jumping to the first stuck card | `AppShell.tsx` | **shipped** |
| Two terminals side by side, with Split *disabled and giving its reason* | `packages/ui/src/splitAvailability.ts` | **shipped** |

Three rules the figures settle, which matter more than the pixels:

**A control that cannot be used is disabled with its reason on it, never
absent.** A missing control teaches nothing and invites the same attempt
tomorrow; a disabled one that says why teaches once.

**Nothing is automatic on fan-out.** Three agents running does not mean two
panes open: the person asks for the pair that belongs side by side, because
only they know which diff is about to be reviewed against which.

**The good case stays quiet.** A running agent is visible but never competes
with a failed or blocked one, and an idle tab shows no dot.

The layout was measured rather than guessed, and the measurement constrains the
design: `WorktreePanel` is a fixed `w-72`, so on a 1440 window opening the git
panel costs the split. The floor is 592 px — 576 px of glyph plus the viewport
scrollbar — and collapsing the sidebar to its 40 px rail buys 184 px and does
not make three panes fit even at 1920. So a third pane is not a thing to add
later; it does not fit, and the split is what closes.

---

## Open, and in order

1. `0c3211ab` — fan-out in one tree. Read *What went with claims* first:
   siblings' red tests and files now count against each other's checks.
2. `cada336b` — install dependencies per worktree via a setup script.
3. The twelve children of `998fa96c` — the Orca reuse list above.

## The shape to watch for

Features here have shipped **complete on both ends and disconnected in the
middle**: the item route dropped `externalId` because it destructures an
allowlist; agent runs have a reader and a writer that nobody joined. Each was invisible for the same
reason — a feature never exercised end to end reports success at every layer it
has.
