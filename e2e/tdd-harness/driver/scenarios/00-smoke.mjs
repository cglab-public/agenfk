/** The harness itself works: the server answers, and the CLI reaches it. */
import { api, cli } from '../lib.mjs';

export const scenarios = [
  {
    name: 'the server answers REST',
    check: 'harness',
    expected: 'pass',
    run: async () => {
      const r = await api('GET', '/projects');
      return { actual: r.status === 200 ? 'pass' : 'fail', detail: `GET /projects -> ${r.status}` };
    },
  },
  {
    name: 'the CLI reaches the server',
    check: 'harness',
    expected: 'pass',
    run: async () => {
      const r = cli(['list-projects', '--json']);
      return { actual: r.code === 0 ? 'pass' : 'fail', detail: r.out.slice(-600) };
    },
  },
];
