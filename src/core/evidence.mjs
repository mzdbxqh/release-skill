/**
 * Structured evidence writer for release-skill.
 *
 * Creates append-only JSONL evidence streams with automatic redaction
 * of sensitive keys and known token/credential prefixes.
 *
 * @module evidence
 */

import { open, mkdir, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

/** Schema version for evidence events. */
const SCHEMA_VERSION = 1;

/**
 * Key-name pattern that indicates a sensitive value requiring redaction.
 * Matches: token, secret, password, authorization, cookie (case-insensitive).
 */
const SENSITIVE_KEY_PATTERN = /token|secret|password|authorization|cookie/i;

/**
 * Known credential prefixes. Order matters for longest-prefix-first matching.
 * Each entry maps a prefix string to its display label.
 */
const CREDENTIAL_PREFIXES = [
  { prefix: 'github_pat_', label: 'github_pat_' },
  { prefix: 'ghp_',       label: 'ghp_' },
  { prefix: 'npm_',       label: 'npm_' },
  { prefix: 'AKIA',       label: 'AKIA' },
];

const REDACTED = '[REDACTED]';

/**
 * Recursively redact sensitive values in an object.
 *
 * Redaction rules:
 * 1. If a key name matches `SENSITIVE_KEY_PATTERN`, its value is replaced
 *    with `[REDACTED]`.
 * 2. If a string value starts with a known credential prefix, it is replaced
 *    with `[REDACTED:<PREFIX>]`.
 *
 * @param {*} obj - The value to redact (object, array, string, or primitive).
 * @returns {*} A new value with sensitive data redacted.
 */
export function redact(obj) {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => redact(item));
  }

  if (typeof obj === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        result[key] = REDACTED;
      } else {
        result[key] = redact(value);
      }
    }
    return result;
  }

  if (typeof obj === 'string') {
    for (const { prefix, label } of CREDENTIAL_PREFIXES) {
      if (obj.startsWith(prefix)) {
        return `[REDACTED:${label}]`;
      }
    }
  }

  return obj;
}

/**
 * Create an evidence writer that appends structured JSONL events and
 * produces a summary JSON file.
 *
 * @param {Object} options
 * @param {string} options.runDir - Absolute path to the run directory. The
 *   directory name (last segment) is used as the `runId`.
 * @param {string} options.command - The top-level command being executed
 *   (e.g. "prepare", "publish").
 * @param {() => string} [options.clock] - Optional clock function returning
 *   an ISO-8601 timestamp string. Defaults to `() => new Date().toISOString()`.
 * @returns {{ append: (event: Object) => Promise<void>, finish: (summary: Object) => Promise<void> }}
 */
export function createEvidenceWriter({ runDir, command, clock }) {
  const clockFn = typeof clock === 'function' ? clock : () => new Date().toISOString();
  const runId = basename(runDir);
  const evidencePath = `${runDir}/evidence.jsonl`;
  const summaryPath = `${runDir}/summary.json`;

  let sequence = 0;
  let handle = null;

  /**
   * Lazily open the evidence file for appending.
   * Creates the run directory if it does not exist.
   */
  async function ensureHandle() {
    if (handle === null) {
      await mkdir(runDir, { recursive: true });
      handle = await open(evidencePath, 'a');
    }
  }

  /**
   * Append a single event to the evidence JSONL stream.
   *
   * The event is enriched with automatic metadata:
   * - `schemaVersion`: always 1
   * - `runId`: extracted from the run directory name
   * - `sequence`: auto-incrementing integer starting at 0
   * - `timestamp`: ISO-8601 string from the clock
   * - `command`: the command passed at creation time
   *
   * The entire event object is redacted before writing.
   *
   * @param {Object} event - The event data. Must include `phase` and `status`;
   *   may include `error` and any other fields.
   */
  async function append(event) {
    await ensureHandle();

    const enriched = {
      schemaVersion: SCHEMA_VERSION,
      runId,
      sequence,
      timestamp: clockFn(),
      command,
      ...event,
    };

    sequence += 1;

    const redacted = redact(enriched);
    const line = JSON.stringify(redacted);

    await handle.write(`${line}\n`, null, 'utf8');
  }

  /**
   * Write the final summary file and close the evidence stream.
   *
   * The summary is redacted before writing.
   *
   * @param {Object} summary - The run summary object.
   */
  async function finish(summary) {
    await ensureHandle();

    const redacted = redact(summary);
    await writeFile(summaryPath, JSON.stringify(redacted, null, 2), 'utf8');

    if (handle !== null) {
      await handle.close();
      handle = null;
    }
  }

  return { append, finish };
}
