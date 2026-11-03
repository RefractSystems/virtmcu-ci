// The RFC 8693 wire facts of keyless CI exchange, defined once for the GitHub Action client
// and the server grant handler. Pure: no external imports, so a standalone runner can load it anywhere.
export const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
export const JWT_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:jwt";
export const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
export const VIRTMCU_CI_CLIENT_ID = "virtmcu-ci";
export const CI_AUDIENCE_PREFIX = "virtmcu:ci:";

export const buildExchangeBody = ({ subjectToken, resource }) => ({
  grant_type: TOKEN_EXCHANGE_GRANT,
  subject_token_type: JWT_TOKEN_TYPE,
  client_id: VIRTMCU_CI_CLIENT_ID,
  resource,
  subject_token: subjectToken,
});

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
  if (json.issued_token_type !== ACCESS_TOKEN_TYPE && json.issued_token_type !== JWT_TOKEN_TYPE) {
    throw new Error(`token exchange returned issued_token_type ${json.issued_token_type}, expected ${ACCESS_TOKEN_TYPE}`);
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
