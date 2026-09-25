/**
 * Shipped flow presets (CGLAB-381): flows a project can adopt, with the step
 * roles that make their checks run. The TDD flow's steps and exit criteria are
 * the community registry's TDD Flow (1.0.3); the roles are what this file adds.
 */
import type { Flow } from "./types.js";

export const TDD_FLOW_PRESET: Flow = {
  id: "preset-tdd",
  name: "TDD Flow",
  description: "TDD-based workflow that begins with the tests, failing at start, then moves the flow forward and makes the tests pass through actual funcionality implementation.",
  version: "2.0.0",
  steps: [
  {
    "id": "tdd-todo",
    "name": "TODO",
    "label": "To Do",
    "order": 0,
    "isAnchor": true
  },
  {
    "id": "tdd-discovery",
    "name": "DISCOVERY",
    "label": "Discovery",
    "order": 1,
    "exitCriteria": "If the user request is not specific enough, questions must be asked so the details are good enough to start the implementation. \nOnce you have all the information, cards at right granulaty (Epic, Story, Task or Bug) must be fully created.\nThe user must give you the go-ahead before you move forward with the implementation. ",
    "color": "#d0e5a4",
    "icon": "search",
    "role": "planning",
    "checks": [
      {
        "id": "jira-key-valid"
      },
      {
        "id": "has-children"
      },
      {
        "id": "human-approval"
      }
    ]
  },
  {
    "id": "tdd-create-unit-tests",
    "name": "CREATE_UNIT_TESTS",
    "label": "Unit Tests",
    "order": 2,
    "exitCriteria": "All Tests for the required functionality should be implemented so that they reflect future functionality - they can all fail at this point, no problem. Tests will guide the implementation itself. All code starts with the test.\n\nMANDATORY:User must inform the JIRA item key that will be part of the item branch name (JIRA integration):\n\nStory,Task,Epic - feat/JIRAKEY_<description> \nBug- \nfix/JIRAKEY_<description>",
    "color": "#498373",
    "icon": "flask",
    "role": "test-authoring"
  },
  {
    "id": "tdd-in-progress",
    "name": "IN_PROGRESS",
    "label": "In Progress",
    "order": 3,
    "exitCriteria": "All tests are passing, because functionality that is tested by them is actually implemented and working.\n\n## IMPORTANT\nPython and other single threaded runtimes should be taken into considearation when writing server-side code (MCPs, FastAPIs, etc.). Blocking calls (CPU-heavy, Network, I/O, Darabase operations) should be executed asynchronously or in a separate thread:\n\n1. Use Asyncio for I/O Bound TasksSwitch to asynchronous frameworks like FastAPI or Sanic and use async libraries.Use httpx.AsyncClient instead of requests.Use asyncpg or motor instead of blocking DB drivers.Always await long-running I/O operations.\n\n2. Offload to Thread or Process PoolsIf you must use a blocking library in an async app, run it concurrently.Use asyncio.to_thread() for standard blocking I/O.Use loop.run_in_executor() with a ProcessPoolExecutor for CPU-heavy tasks.\n\n3. Implement Background Task QueuesMove heavy work completely out of the HTTP request-response cycle.Use Celery, Dramatiq, or RQ.Hand off tasks like sending emails or generating PDFs.Return a 202 Accepted status code immediately to the user.\n\nBest Practices\n\nSet timeouts: Never make network calls without a strict timeout limit.Profile your code: Use tools like viztracer or yappi to find bottlenecks.Enable asyncio debug mode: It logs warnings when tasks block the event loop for too long.",
    "role": "coding"
  },
  {
    "id": "tdd-refactor",
    "name": "REFACTOR",
    "label": "Refactor",
    "order": 4,
    "exitCriteria": "The suite was green when you entered this step and MUST still be green when you\nleave it — with the same tests. Behaviour does not change here; only the shape of\nthe code does.\n\nClean up what \"make it pass\" left behind:\n- Remove duplication introduced while getting to green (extract the abstraction\n  that is now obvious, not one you are guessing at).\n- Fix names that no longer describe what the code does.\n- Delete dead code, commented-out attempts, debug logging, and any temporary\n  scaffolding or hardcoded values used to force a test green.\n- Collapse any special-casing that only existed to satisfy one test.\n\nMANDATORY test-integrity check before advancing. List the test NAMES before and\nafter this step using whatever the project's runner provides, and diff them —\ncounts alone hide a swap. No test may have been deleted, renamed away, skipped,\nor had its assertions weakened. If a test is gone, restore it. A green suite with\nfewer tests than you started with is a FAILED refactor.\n\nState explicitly what you refactored and what you deliberately left alone. \"No\nrefactoring needed\" is an acceptable outcome, but it must be a stated judgement\nwith a reason — not a silently skipped step.",
    "color": "#438976",
    "icon": "book",
    "role": "refactoring"
  },
  {
    "id": "tdd-review",
    "name": "REVIEW",
    "label": "Review",
    "order": 5,
    "exitCriteria": "Review the code as a senior engineer in a separate adversarial general purpose agent. Focus on:\n            - Correctness, edge cases, and likely bugs\n            - Security (input validation, secrets, authz, injection)\n            - Performance regressions and N+1 queries\n            - Concurrency / async correctness (Python asyncio, JS promises)\n            - Test coverage gaps for changed behavior\n            - Breaking API changes or migration risk\n            - Blocking main thread in single-threaded runtimes (such as Python)",
    "color": "#cdbc04",
    "icon": "lightbulb",
    "role": "review"
  },
  {
    "id": "tdd-done",
    "name": "DONE",
    "label": "Done",
    "order": 6,
    "isAnchor": true,
    "role": "closing"
  }
] as Flow['steps'],
  createdAt: new Date("2026-09-24T00:00:00.000Z"),
  updatedAt: new Date("2026-09-24T00:00:00.000Z"),
};
