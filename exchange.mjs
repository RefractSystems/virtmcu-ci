// The keyless CI exchange as pure functions: fetch and the output sink are injected, so the tests
// drive every branch with no network and no real GitHub token. The wire literals come from the one
// shared module the server handler also imports, never copied here.
import { buildExchangeBody, CI_AUDIENCE_PREFIX, JWT_TOKEN_TYPE } from "../../web/lib/ciTokenExchangeWire.mjs";

const FORM = "application/x-www-form-urlencoded";
// A control character in a value written to GITHUB_OUTPUT could start a new output key.
const CONTROL = /[\u0000-\u001f\u007f]/;

export const ciAudience = (registrationId) => `${CI_AUDIENCE_PREFIX}${registrationId}`;

// Exchanges one GitHub OIDC token for a virtmcu access token. The OIDC token is masked before the
// request leaves, and the access token is masked before it is written anywhere. Fails loudly on any
// non-success response and never includes the subject token in the error text.
export async function exchangeOidcForAccessToken({ fetchImpl, tokenEndpoint, oidcToken, resource, output }) {
  if (!tokenEndpoint) throw new Error("token-endpoint input is required");
  if (!oidcToken) throw new Error("the GitHub OIDC token is empty; did the job grant id-token: write?");
  output.mask(oidcToken);

  const body = new URLSearchParams(buildExchangeBody({ subjectToken: oidcToken, resource })).toString();
  const res = await fetchImpl(tokenEndpoint, {
    method: "POST",
    headers: { "content-type": FORM },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = json.error_description ?? json.error ?? "no error body";
    throw new Error(`token exchange rejected with HTTP ${res.status}: ${reason}`);
  }
  // RFC 8693 requires issued_token_type in the response; its absence is a protocol violation.
  if (json.issued_token_type !== JWT_TOKEN_TYPE) {
    throw new Error(`token exchange returned issued_token_type ${json.issued_token_type}, expected ${JWT_TOKEN_TYPE}`);
  }
  const accessToken = json.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new Error("token exchange response carried no access_token");
  }
  if (CONTROL.test(accessToken)) {
    throw new Error("token exchange returned an access_token with control characters; refusing to write it to the job output");
  }
  output.mask(accessToken);
  output.set("access-token", accessToken);
  return accessToken;
}
