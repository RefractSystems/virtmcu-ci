// Scenario file parser, validator, and compiler for virtmcu-scenario.toml.
// Compiles a versioned multi-node CLI scenario into a /v1/runs request payload (CreateRunRequest).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SCHEMA_PATH = path.resolve(__dirname, "scenario.schema.json");

/**
 * Loads the JSON Schema SSoT.
 */
export function loadScenarioSchema() {
  const raw = fs.readFileSync(SCHEMA_PATH, "utf-8");
  return JSON.parse(raw);
}

/**
 * Strict subset TOML parser for virtmcu-scenario.toml.
 * Supported constructs:
 * - Line comments starting with #
 * - Sections: [table]
 * - Array of sections: [[array_of_tables]]
 * - Key-value assignments: key = value
 * - Value types: basic string ("..."), literal string ('...'), integer, float, boolean, array ([...])
 * Fails loud on any unsupported or malformed syntax.
 */
export function parseToml(tomlStr) {
  const root = {};
  let currentTable = root;

  const lines = tomlStr.split(/\r?\n/);
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    let line = lines[lineIdx].trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    line = stripComment(line);
    if (!line) continue;

    // Array of tables: [[section]]
    if (line.startsWith("[[") && line.endsWith("]]")) {
      const sectionName = line.slice(2, -2).trim();
      if (!sectionName || sectionName.includes(".") || sectionName.includes("[")) {
        throw new Error(`Line ${lineIdx + 1}: unsupported or malformed array-of-tables header '${line}'`);
      }
      if (!root[sectionName]) {
        root[sectionName] = [];
      }
      if (!Array.isArray(root[sectionName])) {
        throw new Error(`Line ${lineIdx + 1}: '${sectionName}' already defined as non-array`);
      }
      const newElem = {};
      root[sectionName].push(newElem);
      currentTable = newElem;
      continue;
    }

    // Table: [section]
    if (line.startsWith("[") && line.endsWith("]")) {
      const sectionName = line.slice(1, -1).trim();
      if (!sectionName || sectionName.includes(".") || sectionName.includes("[")) {
        throw new Error(`Line ${lineIdx + 1}: unsupported or malformed table header '${line}'`);
      }
      if (!root[sectionName]) {
        root[sectionName] = {};
      }
      if (typeof root[sectionName] !== "object" || Array.isArray(root[sectionName])) {
        throw new Error(`Line ${lineIdx + 1}: '${sectionName}' already defined as an array or primitive`);
      }
      currentTable = root[sectionName];
      continue;
    }

    // Key-value pair: key = value
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) {
      throw new Error(`Line ${lineIdx + 1}: expected key = value, got: ${line}`);
    }

    const rawKey = line.slice(0, eqIdx).trim();
    const rawVal = line.slice(eqIdx + 1).trim();
    if (!rawKey) {
      throw new Error(`Line ${lineIdx + 1}: missing key before '='`);
    }

    if (rawKey.includes(".")) {
      throw new Error(`Line ${lineIdx + 1}: dotted keys are unsupported: '${rawKey}'`);
    }

    const key = parseKey(rawKey);
    const value = parseValue(rawVal, lineIdx + 1);

    if (Object.prototype.hasOwnProperty.call(currentTable, key)) {
      throw new Error(`Line ${lineIdx + 1}: duplicate key '${key}'`);
    }

    currentTable[key] = value;
  }

  return root;
}

function stripComment(line) {
  let inDouble = false;
  let inSingle = false;
  let escaped = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\" && inDouble) {
      escaped = !escaped;
      continue;
    }
    if (ch === '"' && !escaped && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === "'" && !escaped && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === "#" && !inDouble && !inSingle) {
      return line.slice(0, i).trim();
    }
    escaped = false;
  }
  return line;
}

function parseKey(raw) {
  raw = raw.trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}

function parseValue(raw, lineNum) {
  raw = raw.trim();
  if (!raw) {
    throw new Error(`Line ${lineNum}: missing value`);
  }

  if (raw.startsWith("{")) {
    throw new Error(`Line ${lineNum}: inline tables are unsupported: ${raw}`);
  }

  // String: "..." (JSON-style escapes) or '...' (literal string)
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    try {
      return JSON.parse(raw);
    } catch (e) {
      throw new Error(`Line ${lineNum}: invalid quoted string escape: ${e.message}`);
    }
  }
  if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
    return raw.slice(1, -1);
  }

  // Boolean
  if (raw === "true") return true;
  if (raw === "false") return false;

  // Integer
  if (/^-?\d+$/.test(raw)) {
    const num = parseInt(raw, 10);
    if (!Number.isSafeInteger(num)) {
      throw new Error(`Line ${lineNum}: integer overflow for value ${raw}`);
    }
    return num;
  }

  // Float
  if (/^-?\d+\.\d+$/.test(raw)) {
    return parseFloat(raw);
  }

  // Array: [ ... ]
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((s) => parseValue(s.trim(), lineNum));
  }

  throw new Error(`Line ${lineNum}: unrecognized value literal: ${raw}`);
}

/**
 * Validates parsed data against the schema SSoT (actions/virtmcu-ci/scenario.schema.json).
 * Derives allowed keys and types dynamically from the JSON Schema.
 */
export function validateScenario(data, schema = loadScenarioSchema()) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Invalid scenario: root must be an object");
  }

  // 1. Root level checks derived from schema.properties and schema.required
  const rootProps = new Set(Object.keys(schema.properties || {}));
  for (const k of Object.keys(data)) {
    if (!rootProps.has(k)) {
      throw new Error(`Invalid scenario: unknown top-level key '${k}'`);
    }
  }

  for (const req of schema.required || []) {
    if (!(req in data)) {
      throw new Error(`Invalid scenario: missing required top-level property '${req}'`);
    }
  }

  if (data.schema_version !== 1) {
    throw new Error(`Invalid scenario: unsupported schema_version ${data.schema_version} (must be 1)`);
  }

  // 2. [scenario] section validation
  const scenarioSchema = schema.properties.scenario || {};
  const scenarioProps = new Set(Object.keys(scenarioSchema.properties || {}));
  if (!data.scenario || typeof data.scenario !== "object" || Array.isArray(data.scenario)) {
    throw new Error("Invalid scenario: [scenario] section is required and must be a table");
  }
  for (const k of Object.keys(data.scenario)) {
    if (!scenarioProps.has(k)) {
      throw new Error(`Invalid scenario: unknown key '${k}' in [scenario]`);
    }
  }
  for (const req of scenarioSchema.required || []) {
    if (!(req in data.scenario)) {
      throw new Error(`Invalid scenario: missing required property '${req}' in [scenario]`);
    }
  }
  if (typeof data.scenario.name !== "string" || !data.scenario.name.trim()) {
    throw new Error("Invalid scenario: scenario.name must be a non-empty string");
  }
  if (typeof data.scenario.world !== "string" || !data.scenario.world.trim()) {
    throw new Error("Invalid scenario: scenario.world must be a non-empty string");
  }
  if (typeof data.scenario.timeout_vtime_ms !== "number" || data.scenario.timeout_vtime_ms <= 0) {
    throw new Error("Invalid scenario: scenario.timeout_vtime_ms must be a positive integer");
  }

  // 3. [nodes] section validation
  if (!data.nodes || typeof data.nodes !== "object" || Array.isArray(data.nodes)) {
    throw new Error("Invalid scenario: [nodes] section is required and must be a table");
  }

  const declaredNodes = new Set();
  for (const [nodeKey, fwPath] of Object.entries(data.nodes)) {
    const nodeIdx = parseInt(nodeKey, 10);
    if (isNaN(nodeIdx) || nodeIdx < 0) {
      throw new Error(`Invalid scenario: invalid node index '${nodeKey}' in [nodes]`);
    }
    if (typeof fwPath !== "string" || !fwPath.trim()) {
      throw new Error(`Invalid scenario: firmware path for node ${nodeKey} must be a non-empty string`);
    }
    declaredNodes.add(nodeIdx);
  }

  if (declaredNodes.size === 0) {
    throw new Error("Invalid scenario: [nodes] must declare at least one node");
  }

  // 4. [[steps]] array validation
  const stepSchema = (schema.properties.steps && schema.properties.steps.items) || {};
  const stepProps = new Set(Object.keys(stepSchema.properties || {}));
  if (!Array.isArray(data.steps)) {
    throw new Error("Invalid scenario: [[steps]] must be an array of step tables");
  }

  for (let i = 0; i < data.steps.length; i++) {
    const step = data.steps[i];
    if (!step || typeof step !== "object" || Array.isArray(step)) {
      throw new Error(`Invalid scenario: step ${i} must be a table`);
    }
    for (const k of Object.keys(step)) {
      if (!stepProps.has(k)) {
        throw new Error(`Invalid scenario: unknown key '${k}' in step ${i}`);
      }
    }
    for (const req of stepSchema.required || []) {
      if (!(req in step)) {
        throw new Error(`Invalid scenario: step ${i} missing required property '${req}'`);
      }
    }
    if (typeof step.node !== "number" || step.node < 0) {
      throw new Error(`Invalid scenario: step ${i} invalid 'node' integer`);
    }
    if (typeof step.delivery_vtime_ms !== "number" || step.delivery_vtime_ms < 0) {
      throw new Error(`Invalid scenario: step ${i} invalid 'delivery_vtime_ms' integer`);
    }
    if (typeof step.data !== "string") {
      throw new Error(`Invalid scenario: step ${i} invalid 'data' string`);
    }

    // Out-of-world node check: scenario internal consistency check (characterization proof target)
    if (!declaredNodes.has(step.node)) {
      const avail = Array.from(declaredNodes).sort((a, b) => a - b).join(", ");
      throw new Error(`Invalid scenario: step ${i} targets node ${step.node} which is not declared in [nodes] (declared: [${avail}])`);
    }
  }
}

/**
 * Compiles scenario TOML into CreateRunRequest payload fields.
 * If baseDir is provided, firmware paths in [nodes] are resolved relative to baseDir.
 */
export function compileScenario(tomlStr, { baseDir = "" } = {}) {
  const parsed = parseToml(tomlStr);
  validateScenario(parsed);

  const firmware = {};
  for (const [nodeId, fwPath] of Object.entries(parsed.nodes)) {
    if (baseDir && !path.isAbsolute(fwPath)) {
      firmware[nodeId] = path.resolve(baseDir, fwPath);
    } else {
      firmware[nodeId] = fwPath;
    }
  }

  const console_input = parsed.steps.map((step) => ({
    node: step.node,
    delivery_vtime_ms: step.delivery_vtime_ms,
    data: step.data.endsWith("\n") ? step.data : step.data + "\n",
  }));

  return {
    world: parsed.scenario.world,
    firmware,
    timeout_vtime_ms: parsed.scenario.timeout_vtime_ms,
    pass_regex: parsed.scenario.pass_regex || null,
    fail_regex: parsed.scenario.fail_regex || null,
    console_input,
    name: parsed.scenario.name,
  };
}

/**
 * Load and compile scenario file from path.
 */
export function loadScenarioFile(filePath) {
  const resolvedPath = path.resolve(filePath);
  const content = fs.readFileSync(resolvedPath, "utf-8");
  return compileScenario(content, { baseDir: path.dirname(resolvedPath) });
}
