/**
 * How many times a caller may hit an expensive route (CodeQL js/missing-rate-limiting).
 *
 * Five routes on this server do real work per request: `git status` and the PR
 * import spawn processes, the file listing walks a directory, worktree creation
 * checks out a repository. None had a ceiling, so a loop in a client - or a
 * retry storm, or an agent that misreads slowness as failure and re-asks - can
 * spend the machine.
 *
 * THIS FILE IS THE NUMBER, NOT THE MECHANISM. The counting is done by
 * express-rate-limit, which is what CodeQL recognises and what handles the
 * standard headers and proxy cases properly. A hand-rolled counter lived here
 * first, with its own window and sweep, and it is gone rather than kept
 * uncalled: an exported function with no consumer is the defect this branch
 * spent its length finding in other people's code.
 *
 * What a library cannot choose is the ceiling, so that stays here with its
 * reasoning and its tests.
 *
 * THE THREAT MODEL IS A RUNAWAY LOOP, NOT AN ATTACKER. The server binds to
 * loopback and refuses cross-origin browsers, so nothing here is reachable from
 * the network; what it is reachable from is every process on the machine,
 * including the agents this product exists to run. The limit is set to stop a
 * loop, not to ration a person.
 *
 * THE FLOOR IS SET BY WHAT THE APP ITSELF DOES. The UI polls git-status every
 * four seconds, so fifteen requests a minute is ORDINARY use. Any ceiling near
 * that breaks the product to satisfy a static-analysis alert, which is the
 * wrong trade and an easy one to make without checking. Sixty a minute leaves
 * the normal case four times under the line and still stops a loop dead.
 */

/** Requests allowed per window, per caller, per route, per item. */
export const EXPENSIVE_ROUTE_LIMIT = 60;

/** The window, in ms. */
export const EXPENSIVE_ROUTE_WINDOW_MS = 60_000;
