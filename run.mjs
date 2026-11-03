// Simulation run client for virtmcu-ci action (POST /v1/runs, poll status, download artifacts, emit JUnit + Step Summary).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function formatJunit({ outcome, exitCode, consoleText = "", finalVtimeNs = 0, fault = null }) {
  const durationS = ((finalVtimeNs || 0) / 1_000_000_000).toFixed(6);
  let failures = 0;
  let errors = 0;
  let failureElement = "";

  let details = `Outcome: ${outcome}\nExit Code: ${exitCode}\n`;
  if (fault) {
    details += `Fault PC: 0x${fault.fault_pc.toString(16)}\nCFSR: 0x${fault.cfsr.toString(16)}\n`;
  }

  if (outcome === "fail") {
    failures = 1;
    const msg = escapeXml("simulation failed");
    const text = escapeXml(details);
    failureElement = `    <failure message="${msg}" type="Failure">${text}</failure>\n`;
  } else if (outcome === "timeout" || outcome === "timed_out_stalled") {
    errors = 1;
    const msg = escapeXml(outcome === "timeout" ? "simulation timed out" : "simulation stalled");
    const text = escapeXml(details);
    failureElement = `    <error message="${msg}" type="Timeout">${text}</error>\n`;
  } else if (outcome === "error") {
    errors = 1;
    const msg = escapeXml("simulation error");
    const text = escapeXml(details);
    failureElement = `    <error message="${msg}" type="Error">${text}</error>\n`;
  }

  const escapedConsole = escapeXml(consoleText);
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites tests="1" failures="${failures}" errors="${errors}" time="${durationS}">
  <testsuite name="simulation" tests="1" failures="${failures}" errors="${errors}" time="${durationS}">
    <testcase name="simulation" classname="virtmcu" time="${durationS}">
${failureElement}      <system-out>${escapedConsole}</system-out>
    </testcase>
  </testsuite>
</testsuites>
`;
}

export function formatSummary({ outcome, exitCode, finalVtimeNs = 0, fault = null, artifacts = [] }) {
  let out = "# VirtMCU Simulation Run Summary\n\n";
  out += `- **Outcome**: ${outcome}\n`;
  out += `- **Exit Code**: ${exitCode}\n`;
  out += `- **Final Virtual Time**: ${finalVtimeNs} ns\n`;

  if (fault) {
    out += "\n## Fault Details\n\n";
    out += `- **Fault PC**: 0x${fault.fault_pc.toString(16)}\n`;
    out += `- **CFSR**: 0x${fault.cfsr.toString(16)}\n`;
    out += `- **HFSR**: 0x${fault.hfsr.toString(16)}\n`;
    out += `- **BFAR**: 0x${fault.bfar.toString(16)}\n`;
  }

  if (artifacts && artifacts.length > 0) {
    out += "\n## Artifacts\n\n";
    const sorted = [...artifacts].sort();
    for (const art of sorted) {
      out += `- [${art}](${art})\n`;
    }
  }

  return out;
}

export function parseFirmware(input, firmwareRoot = "") {
  if (!input) {
    throw new Error("firmware input is required");
  }

  let map = {};
  if (typeof input === "object" && input !== null) {
    map = input;
  } else if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.startsWith("{")) {
      map = JSON.parse(trimmed);
    } else if (trimmed.includes("\n") || trimmed.includes(":")) {
      const lines = trimmed.split("\n");
      for (const line of lines) {
        const l = line.trim();
        if (!l || l.startsWith("#")) continue;
        const idx = l.indexOf(":");
        if (idx !== -1) {
          const k = l.slice(0, idx).trim();
          const v = l.slice(idx + 1).trim();
          map[k] = v;
        }
      }
    }
    if (Object.keys(map).length === 0) {
      map = { "0": trimmed };
    }
  }

  const result = {};
  for (const [nodeId, relPath] of Object.entries(map)) {
    const fullPath = path.isAbsolute(relPath) ? relPath : path.resolve(firmwareRoot, relPath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`firmware file for node ${nodeId} not found at: ${fullPath}`);
    }
    const buf = fs.readFileSync(fullPath);
    if (buf.length < 4 || buf[0] !== 0x7f || buf[1] !== 0x45 || buf[2] !== 0x4c || buf[3] !== 0x46) {
      throw new Error(`node ${nodeId} firmware is not a valid ELF binary`);
    }
    result[nodeId] = buf.toString("base64");
  }
  return result;
}

export async function submitRun({ api, accessToken, body, fetchImpl = fetch }) {
  const url = `${api.replace(/\/+$/, "")}/v1/runs`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`HTTP ${res.status}: ${text}`);
    err.status = res.status;
    err.exitCode = 1;
    throw err;
  }

  const data = await res.json();
  const runId = data.run_id || data.id;
  if (!runId) {
    throw new Error("API returned no run_id in response");
  }
  return runId;
}

export async function pollRun({
  api,
  accessToken,
  runId,
  fetchImpl = fetch,
  pollIntervalMs = 1000,
  pollTimeoutMs = 300000,
}) {
  const url = `${api.replace(/\/+$/, "")}/v1/runs/${runId}`;
  const start = Date.now();

  while (true) {
    if (Date.now() - start > pollTimeoutMs) {
      const err = new Error(`poll timeout: run ${runId} did not complete within ${pollTimeoutMs}ms`);
      err.exitCode = 1;
      throw err;
    }

    const res = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!res.ok) {
      const text = await res.text();
      const err = new Error(`HTTP ${res.status}: ${text}`);
      err.status = res.status;
      err.exitCode = 1;
      throw err;
    }

    const data = await res.json();
    if (data.status === "completed" || data.status === "error") {
      return data;
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

export async function downloadArtifacts({
  api,
  accessToken,
  runResult,
  outDir,
  fetchImpl = fetch,
}) {
  const artifactsDir = path.join(outDir, "artifacts");
  fs.mkdirSync(artifactsDir, { recursive: true });

  fs.writeFileSync(path.join(outDir, "run.json"), JSON.stringify(runResult, null, 2) + "\n");

  const links = [];
  if (Array.isArray(runResult.artifacts)) {
    links.push(...runResult.artifacts);
  }
  if (runResult.result && Array.isArray(runResult.result.artifacts)) {
    links.push(...runResult.result.artifacts);
  }

  for (const link of links) {
    const filename = path.basename(link);
    const fullUrl = link.startsWith("http")
      ? link
      : `${api.replace(/\/+$/, "")}${link.startsWith("/") ? "" : "/"}${link}`;

    const res = await fetchImpl(fullUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (res.ok) {
      const arrayBuffer = await res.arrayBuffer();
      fs.writeFileSync(path.join(artifactsDir, filename), Buffer.from(arrayBuffer));
    }
  }
}

export async function runCase({
  env = process.env,
  fetchImpl = fetch,
  output,
  pollIntervalMs = 1000,
  pollTimeoutMs = 300000,
}) {
  const api = env.INPUT_API || env.VIRTMCU_API;
  if (!api) throw new Error("INPUT_API or VIRTMCU_API is required");

  const accessToken = env["INPUT_ACCESS-TOKEN"] || env.VIRTMCU_ACCESS_TOKEN;
  if (!accessToken) throw new Error("INPUT_ACCESS-TOKEN or VIRTMCU_ACCESS_TOKEN is required");

  const world = env.INPUT_WORLD || env.VIRTMCU_WORLD;
  if (!world) throw new Error("INPUT_WORLD or VIRTMCU_WORLD is required");

  const firmwareInput = env.INPUT_FIRMWARE || env.VIRTMCU_FIRMWARE;
  const firmwareRoot = env.VIRTMCU_FIRMWARE_ROOT || process.cwd();
  const firmwareMap = parseFirmware(firmwareInput, firmwareRoot);

  const timeoutVtimeMs = Number(env["INPUT_TIMEOUT-VTIME-MS"] || env.VIRTMCU_TIMEOUT_VTIME_MS || 60000);
  const passRegex = env["INPUT_PASS-REGEX"] || env.VIRTMCU_PASS_REGEX || undefined;
  const failRegex = env["INPUT_FAIL-REGEX"] || env.VIRTMCU_FAIL_REGEX || undefined;
  const consoleInputRaw = env["INPUT_CONSOLE-INPUT"] || env.VIRTMCU_CONSOLE_INPUT || undefined;
  let consoleInput = undefined;
  if (consoleInputRaw) {
    if (typeof consoleInputRaw === "string") {
      const trimmed = consoleInputRaw.trim();
      if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
        consoleInput = JSON.parse(trimmed);
      }
    } else if (Array.isArray(consoleInputRaw)) {
      consoleInput = consoleInputRaw;
    }
  }
  const outDir = env["INPUT_OUT-DIR"] || env.VIRTMCU_OUT_DIR || "out";

  fs.mkdirSync(outDir, { recursive: true });

  const body = {
    world,
    firmware: firmwareMap,
    timeout_vtime_ms: timeoutVtimeMs,
    ...(passRegex ? { pass_regex: passRegex } : {}),
    ...(failRegex ? { fail_regex: failRegex } : {}),
    ...(consoleInput ? { console_input: consoleInput } : {}),
  };

  const runId = await submitRun({ api, accessToken, body, fetchImpl });
  if (output?.set) {
    output.set("run-id", runId);
  }

  const runResult = await pollRun({
    api,
    accessToken,
    runId,
    fetchImpl,
    pollIntervalMs,
    pollTimeoutMs,
  });

  const outcome = runResult.outcome || runResult.result?.outcome || "unknown";
  const exitCode = typeof runResult.exit_code === "number"
    ? runResult.exit_code
    : typeof runResult.result?.exit_code === "number"
    ? runResult.result.exit_code
    : outcome === "pass"
    ? 0
    : 1;

  if (output?.set) {
    output.set("outcome", outcome);
    output.set("exit-code", exitCode);
  }

  await downloadArtifacts({ api, accessToken, runResult, outDir, fetchImpl });

  let combinedConsole = "";
  const consoles = runResult.result?.console || runResult.console || {};
  for (const [node, text] of Object.entries(consoles)) {
    combinedConsole += `[node ${node}]:\n${text}\n`;
  }

  const finalVtimeNs = runResult.result?.final_vtime_ns || runResult.final_vtime_ns || 0;
  const fault = runResult.result?.fault || runResult.fault || null;
  const artifactList = runResult.result?.artifacts || runResult.artifacts || [];

  const junitXml = formatJunit({
    outcome,
    exitCode,
    consoleText: combinedConsole,
    finalVtimeNs,
    fault,
  });
  fs.writeFileSync(path.join(outDir, "junit.xml"), junitXml);

  const summaryMd = formatSummary({
    outcome,
    exitCode,
    finalVtimeNs,
    fault,
    artifacts: artifactList,
  });
  fs.writeFileSync(path.join(outDir, "summary.md"), summaryMd);

  const stepSummaryFile = env.GITHUB_STEP_SUMMARY;
  if (stepSummaryFile) {
    try {
      fs.appendFileSync(stepSummaryFile, summaryMd + "\n");
    } catch (_) {}
  }

  const success = outcome === "pass" && exitCode === 0;
  if (!success) {
    const err = new Error(`Simulation failed: outcome=${outcome} (exit ${exitCode})`);
    err.exitCode = exitCode || 1;
    throw err;
  }

  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outputSink = {
    set: (k, v) => {
      const outputFile = process.env.GITHUB_OUTPUT;
      if (outputFile) {
        fs.appendFileSync(outputFile, `${k}=${v}\n`);
      }
    },
  };

  runCase({ env: process.env, output: outputSink })
    .then((code) => {
      process.exit(code);
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(err.exitCode || 1);
    });
}
