/**
 * CGLAB-384 — one-click starting points for the flow editor. The browser
 * cannot import core, so these are copies of core's shipped flows (TDD preset,
 * default flow) plus a docs-only flow; a test pins them to core.
 * Regenerate from packages/core/dist when a preset changes.
 */
import type { FlowStep } from "./types";

export interface FlowTemplate { name: string; description: string; steps: FlowStep[] }

export const FLOW_TEMPLATES: Record<"tdd" | "default" | "docs", FlowTemplate> = {
  "tdd": {
    "name": "TDD",
    "description": "Tests first and failing, then the code that makes them pass, a refactor, and an independent review.",
    "steps": [
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
    ]
  },
  "default": {
    "name": "Default",
    "description": "To Do, In Progress, Review, Test, Done: the suite must pass and the work is reviewed.",
    "steps": [
      {
        "id": "default-todo",
        "name": "TODO",
        "label": "To Do",
        "order": 0,
        "isAnchor": true
      },
      {
        "id": "default-in-progress",
        "name": "IN_PROGRESS",
        "label": "In Progress",
        "order": 1,
        "exitCriteria": "Implement the change. Explore the codebase first and confirm what already exists before claiming it does — search for the specific components, endpoints and queries rather than assuming. Keep the change focused on what was asked. For a defect, trace it from symptom to root cause and fix the cause, one fix at a time, rather than working around it. The project builds.",
        "role": "coding"
      },
      {
        "id": "default-review",
        "name": "REVIEW",
        "label": "Review",
        "order": 2,
        "exitCriteria": "Review everything you changed, and state what you reviewed. Re-read each modified file and check correctness, edge cases, error handling, input validation and authorization, and whether any test you touched still proves what its name claims. If the change is risky or wide, get the review from an independent reviewer rather than yourself — a review by the author carries the author's blind spots. Verify each finding against the code before acting on it, and say which findings you rejected and why.",
        "role": "review"
      },
      {
        "id": "default-test",
        "name": "TEST",
        "label": "Test",
        "order": 3,
        "exitCriteria": "The project's full test suite passes, and the new behaviour is covered by tests that fail if the change is reverted. Report the actual numbers rather than 'tests pass'. Compare the test names before and after your work and confirm none was deleted, renamed away, skipped or had its assertions weakened — a green suite with fewer tests than you started with is a regression, not a pass.",
        "role": "testing"
      },
      {
        "id": "default-done",
        "name": "DONE",
        "label": "Done",
        "order": 4,
        "isAnchor": true,
        "role": "closing"
      }
    ]
  },
  "docs": {
    "name": "Docs-only",
    "description": "Write, get a review, done. No test checks.",
    "steps": [
      {
        "id": "docs-todo",
        "name": "TODO",
        "label": "To Do",
        "order": 0,
        "isAnchor": true
      },
      {
        "id": "docs-writing",
        "name": "WRITING",
        "label": "Writing",
        "order": 1,
        "role": "planning",
        "exitCriteria": "The documentation change is written and linked to its card."
      },
      {
        "id": "docs-review",
        "name": "REVIEW",
        "label": "Review",
        "order": 2,
        "role": "review",
        "exitCriteria": "Someone other than the author reviewed the change."
      },
      {
        "id": "docs-done",
        "name": "DONE",
        "label": "Done",
        "order": 3,
        "isAnchor": true
      }
    ]
  }
};
