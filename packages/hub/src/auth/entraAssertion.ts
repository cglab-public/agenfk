import { STSClient, GetWebIdentityTokenCommand } from '@aws-sdk/client-sts';

// The audience Entra expects on a federated credential issued by an external IdP.
const ENTRA_AUDIENCE = 'api://AzureADTokenExchange';
// The token is spent on one token-endpoint call, seconds after it is minted.
const ASSERTION_TTL_SECONDS = 60;
const STS_TIMEOUT_MS = 5_000;

export const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

/** True when the operator chose to authenticate to Entra with an AWS STS web identity token. Read per call so a test can flip it. */
export function entraAssertionEnabled(): boolean {
  return process.env.AGENFK_HUB_ENTRA_ASSERTION === 'aws-sts';
}

let stsClient: STSClient | undefined;

/** A short-lived RS256 JWT signed by AWS for the caller's IAM role (the ECS task role, via the default credential chain). */
export async function getStsClientAssertion(): Promise<string> {
  let out;
  try {
    stsClient ??= new STSClient({});
    out = await stsClient.send(
      new GetWebIdentityTokenCommand({
        Audience: [ENTRA_AUDIENCE],
        SigningAlgorithm: 'RS256',
        // STS rejects anything below 60.
        DurationSeconds: ASSERTION_TTL_SECONDS,
      }),
      { abortSignal: AbortSignal.timeout(STS_TIMEOUT_MS) },
    );
  } catch (e: any) {
    throw new StsAssertionError(String(e?.message ?? e));
  }
  if (!out.WebIdentityToken) throw new StsAssertionError('STS GetWebIdentityToken returned no token');
  return out.WebIdentityToken;
}

/** The STS call failed. The message is for the server log only: an AccessDenied from STS names the account and role ARN. */
export class StsAssertionError extends Error {}

export interface EntraFailure {
  /** Entra's OAuth `error`, e.g. invalid_client. */
  entraError?: string;
  /** Numeric AADSTS codes, e.g. 7000222. */
  errorCodes?: number[];
  /** For the server log only: Entra's description carries Trace and Correlation IDs. Never holds the secret or the assertion, which are only request fields. */
  detail: string;
}

/** What the token endpoint said, instead of axios's bare "Request failed with status code 401". */
export function describeEntraFailure(e: any): EntraFailure {
  const data = e?.response?.data;
  if (data && typeof data === 'object' && (data.error || data.error_codes)) {
    const errorCodes = Array.isArray(data.error_codes) ? data.error_codes.filter((c: unknown) => typeof c === 'number') : undefined;
    const desc = typeof data.error_description === 'string' ? data.error_description : '';
    const detail = [data.error, desc].filter(Boolean).join(': ').replace(/\s+/g, ' ');
    return { entraError: typeof data.error === 'string' ? data.error : undefined, errorCodes, detail: detail || String(e?.message) };
  }
  return { detail: String(e?.message ?? e) };
}
