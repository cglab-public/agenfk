import supertest from 'supertest';

/**
 * Log in and return the session cookie.
 *
 * Twenty-one spec files had a byte-identical copy of this. It is here once now,
 * and with one addition: if the response carried no `set-cookie`, it logs in
 * again.
 *
 * The retry compensates for the TEST CLIENT, not for the product, and that
 * distinction is the whole justification — it was established by
 * instrumenting the server rather than assumed:
 *
 *  - when a spec failed, the request reached the session guard with NO cookie
 *    at all (`cookies= {}`), so the 401 was a consequence and not the cause;
 *  - the login that preceded it had SUCCEEDED, and the server had written the
 *    header — a probe on the success path reported `set-cookie: yes`;
 *  - none of the login's failure paths ever fired: not bad credentials, not
 *    the per-account lockout, not the per-IP rate limiter, not the API-key
 *    guard.
 *
 * So the server said "here is your cookie" and the client's response object
 * did not have one. A helper that silently returns `''` in that case hands the
 * spec an empty cookie, and the failure then surfaces several requests later
 * as an unexplained 401 — in whichever file happened to run at the time, which
 * is exactly the rotating-failure shape this was chasing.
 *
 * If the retry ever starts firing constantly, that is a signal worth reading:
 * it would mean the product genuinely stopped setting the cookie, and this
 * helper would be hiding it. Hence the warning.
 */
export async function loginAs(app: unknown, email: string, password: string): Promise<string> {
  const first = await supertest(app as never).post('/auth/login').send({ email, password });
  const cookie = first.headers['set-cookie']?.[0];
  if (cookie) return cookie;

  const again = await supertest(app as never).post('/auth/login').send({ email, password });
  const retried = again.headers['set-cookie']?.[0];
  if (!retried) {
    // Twice with no cookie is not a flaky socket. Say so loudly rather than
    // returning '' and letting it surface as a 401 somewhere else.
    throw new Error(
      `Login for ${email} returned no session cookie twice ` +
      `(status ${first.status} then ${again.status}). This is the product, not the transport.`,
    );
  }
  console.warn(`[test] login for ${email} needed a retry to get its cookie`);
  return retried;
}
