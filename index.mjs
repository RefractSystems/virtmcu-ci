// The action's entry point. runAction takes its environment, fetch and output sink as arguments, so the
// tests drive the OIDC request and both output writes without a runner. main() wires the real ones.
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ciAudience, exchangeOidcForAccessToken } from "./exchange.mjs";

const need = (env, name) => {
  const v = env[name];
  if (!v) throw new Error(`${name} is not set; the action must run on a GitHub runner with id-token: write`);
  return v;
};

// The output sink: masks write the workflow command to stdout; set appends to the GITHUB_OUTPUT file
// (the ::set-output command is deprecated).
export function makeOutput({ env, stdout, appendFile }) {
  return {
    mask: (value) => stdout.write(`::add-mask::${value}\n`),
    set: (key, value) => appendFile(need(env, "GITHUB_OUTPUT"), `${key}=${value}\n`),
  };
}

export async function requestOidcToken({ env, fetchImpl, registrationId }) {
  const url = new URL(need(env, "ACTIONS_ID_TOKEN_REQUEST_URL"));
  url.searchParams.set("audience", ciAudience(registrationId));
  const res = await fetchImpl(url, { headers: { authorization: `Bearer ${need(env, "ACTIONS_ID_TOKEN_REQUEST_TOKEN")}` } });
  if (!res.ok) throw new Error(`GitHub OIDC request failed with HTTP ${res.status}`);
  const { value } = await res.json();
  if (typeof value !== "string" || value.length === 0) throw new Error("GitHub OIDC response carried no value");
  return value;
}

export async function runAction({ env, fetchImpl, output }) {
  const registrationId = need(env, "INPUT_REGISTRATION-ID");
  const oidcToken = await requestOidcToken({ env, fetchImpl, registrationId });
  return exchangeOidcForAccessToken({
    fetchImpl,
    tokenEndpoint: need(env, "INPUT_TOKEN-ENDPOINT"),
    oidcToken,
    resource: need(env, "INPUT_RESOURCE"),
    output,
  });
}

// Runs only when this file is the process entry point, never when a test imports it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runAction({
    env: process.env,
    fetchImpl: fetch,
    output: makeOutput({ env: process.env, stdout: process.stdout, appendFile: appendFileSync }),
  });
}
