/**
 * YAML format-preserving three-way merge.
 *
 * Uses YAML CST (via `yaml` library with `keepSourceTokens: true`) to
 * locate and modify values at specific paths.  Comments, anchors/aliases,
 * key order, and scalar styles are preserved by using CST ranges only for
 * locating minimal token replacements; output is never a full re-serialize.
 *
 * If any modification would lose a comment, anchor, alias, scalar style,
 * or key order, the merge fails closed to CONFLICT.
 *
 * Sequences (arrays) without an identity key that are modified on both
 * sides always conflict.
 *
 * @module artifacts/merge/yaml
 */

import YAML from 'yaml';

// ---------------------------------------------------------------------------
// YAML path helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a slash-separated path (e.g. "/deploy/replicas") to a CST node
 * in a YAML Document.
 *
 * @param {YAML.Document} doc
 * @param {string} path - Slash-separated YAML path
 * @returns {YAML.Pair|YAML.Scalar|YAML.YAMLMap|YAML.YAMLSeq|null}
 */
function resolvePath(doc, path) {
  const parts = path.split('/').filter(Boolean);
  let node = doc.contents;

  for (const part of parts) {
    if (node == null) return null;

    if (node.items) {
      // It's a YAMLMap or YAMLSeq
      if (typeof node.get === 'function') {
        // YAMLMap — find by key
        const pair = node.items.find((item) => {
          if (item.key && item.key.value === part) return true;
          return false;
        });
        if (!pair) return null;
        node = pair.value;
      } else {
        return null;
      }
    } else {
      return null;
    }
  }

  return node;
}

/**
 * Find the YAML.Pair that contains a given path's leaf value.
 *
 * @param {YAML.Document} doc
 * @param {string} path
 * @returns {YAML.Pair|null}
 */
function resolvePair(doc, path) {
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) return null;

  let node = doc.contents;
  for (let i = 0; i < parts.length - 1; i++) {
    if (node == null || !node.items) return null;
    const pair = node.items.find((item) =>
      item.key && item.key.value === parts[i],
    );
    if (!pair) return null;
    node = pair.value;
  }

  if (node == null || !node.items) return null;
  return node.items.find((item) =>
    item.key && item.key.value === parts[parts.length - 1],
  ) ?? null;
}

// ---------------------------------------------------------------------------
// CST feature preservation checks
// ---------------------------------------------------------------------------

/**
 * Check whether a YAML Scalar node has features that would be lost by
 * a simple value replacement.
 *
 * @param {YAML.Scalar} node
 * @returns {{ ok: boolean, reason?: string }}
 */
function scalarPreservationCheck(node) {
  if (!node) return { ok: true };

  // Check for anchor
  if (node.anchor) {
    return { ok: false, reason: `anchor '${node.anchor}' on scalar` };
  }

  // Check for comment
  if (node.comment || node.commentBefore) {
    return { ok: false, reason: 'comment on scalar' };
  }

  // Check scalar type/style — if it's a block scalar or quoted, replacing
  // the value might lose the style
  if (node.type) {
    const preserveStyleTypes = [
      'BLOCK_FOLDED', 'BLOCK_LITERAL', 'QUOTE_DOUBLE', 'QUOTE_SINGLE',
    ];
    if (preserveStyleTypes.includes(node.type)) {
      // We can preserve the style by setting the value and keeping the type
      return { ok: true, preserveType: node.type };
    }
  }

  return { ok: true };
}

/**
 * Check whether a YAML node tree has any comments, anchors, or aliases
 * that would be lost by stringify.
 *
 * @param {YAML.Node} node
 * @returns {{ ok: boolean, reason?: string }}
 */
function deepFeatureCheck(node) {
  if (!node) return { ok: true };

  if (node.comment || node.commentBefore) {
    return { ok: false, reason: 'comment found' };
  }

  if (node.anchor) {
    return { ok: false, reason: `anchor '${node.anchor}' found` };
  }

  // Check for aliases
  if (node.type === 'ALIAS') {
    return { ok: false, reason: `alias '${node.source}' found` };
  }

  // Recurse into map/seq items
  if (node.items) {
    for (const item of node.items) {
      if (item.key) {
        const keyCheck = deepFeatureCheck(item.key);
        if (!keyCheck.ok) return keyCheck;
      }
      if (item.value) {
        const valCheck = deepFeatureCheck(item.value);
        if (!valCheck.ok) return valCheck;
      }
    }
  }

  return { ok: true };
}

/**
 * Compare two YAML parsed structures for value equality (ignoring
 * formatting).
 *
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
function yamlValueEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!yamlValueEqual(a[key], b[key])) return false;
  }
  return true;
}

/**
 * Serialize a JS value to YAML string preserving the original scalar
 * style when possible.
 *
 * @param {*} value
 * @param {object} [styleOpts]
 * @returns {string}
 */
function yamlSerializeValue(value, styleOpts = {}) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    if (styleOpts.type === 'BLOCK_FOLDED') return YAML.stringify(value, { defaultKeyType: 'PLAIN' }).trim();
    if (styleOpts.type === 'BLOCK_LITERAL') return YAML.stringify(value, { defaultKeyType: 'PLAIN' }).trim();
    if (styleOpts.type === 'QUOTE_DOUBLE') return JSON.stringify(value);
    if (styleOpts.type === 'QUOTE_SINGLE') return `'${value}'`;
    // Default: use YAML's default
    return YAML.stringify(value).trim();
  }
  return YAML.stringify(value).trim();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Merge two YAML modifications of the same base content.
 *
 * Modifies CST nodes at the specified paths.  Comments, anchors, aliases,
 * key order, and scalar styles are preserved via CST round-trip.
 *
 * Sequences modified on both sides without an identity key always conflict.
 *
 * @param {object} options
 * @param {Buffer} options.base      - Base YAML content.
 * @param {Buffer} options.current   - Current (human) YAML content.
 * @param {Buffer} options.generated - Generated (producer) YAML content.
 * @param {string[]} [options.paths=[]] - YAML paths of values to merge.
 * @param {Record<string,string>} [options.identityKeys={}]
 *   Map of YAML path → identity key name for sequences at that path.
 * @returns {{ status: 'MERGEABLE'|'CONFLICT'|'STRUCTURE_INVALID', bytes?: Buffer, conflicts: object[] }}
 */
export function mergeYaml({ base, current, generated, paths = [], identityKeys = {} } = {}) {
  // Null/missing inputs → CONFLICT
  if (!base || !current || !generated) {
    return Object.freeze({
      status: 'CONFLICT',
      bytes: undefined,
      conflicts: Object.freeze([{ reason: 'missing input' }]),
    });
  }

  // Parse all three sides with CST
  let baseDoc, currentDoc, genDoc;
  try {
    baseDoc = YAML.parseDocument(base.toString('utf8'), { keepSourceTokens: true });
    currentDoc = YAML.parseDocument(current.toString('utf8'), { keepSourceTokens: true });
    genDoc = YAML.parseDocument(generated.toString('utf8'), { keepSourceTokens: true });
  } catch {
    return Object.freeze({
      status: 'STRUCTURE_INVALID',
      bytes: undefined,
      conflicts: Object.freeze([{ reason: 'malformed YAML input' }]),
    });
  }

  // Check for parse errors (YAML parser is lenient, errors are in .errors)
  if (baseDoc.errors?.length > 0 || currentDoc.errors?.length > 0 || genDoc.errors?.length > 0) {
    return Object.freeze({
      status: 'STRUCTURE_INVALID',
      bytes: undefined,
      conflicts: Object.freeze([{ reason: 'YAML parse errors detected' }]),
    });
  }

  // Collect edits to apply to currentDoc
  const edits = [];
  const conflicts = [];

  for (const path of paths) {
    const baseValue = baseDoc.getIn(path.split('/').filter(Boolean));
    const currentValue = currentDoc.getIn(path.split('/').filter(Boolean));
    const genValue = genDoc.getIn(path.split('/').filter(Boolean));

    const safeStringify = (v) => {
      if (v === undefined || v === null) return String(v);
      try { return YAML.stringify(v).trim(); } catch { return String(v); }
    };
    const baseStr = safeStringify(baseValue);
    const currentStr = safeStringify(currentValue);
    const genStr = safeStringify(genValue);

    const currentChanged = baseStr !== currentStr;
    const genChanged = baseStr !== genStr;

    if (!currentChanged && !genChanged) {
      continue; // Both unchanged
    }

    if (currentChanged && genChanged) {
      if (currentStr === genStr) {
        continue; // Same change — already in current
      }

      // Check if this is a sequence without identity key
      const currentValueNode = resolvePath(currentDoc, path);
      if (currentValueNode && currentValueNode.items && Array.isArray(currentValueNode.items)) {
        // It's a sequence (YAMLSeq)
        const idKey = identityKeys[path];
        if (!idKey) {
          conflicts.push({ path, reason: 'sequence modified on both sides without identity key' });
          continue;
        }
        // Identity-keyed sequence merge
        const merged = mergeIdentityKeyedSequence(
          baseDoc, currentDoc, genDoc, path, idKey,
        );
        if (merged === 'CONFLICT') {
          conflicts.push({ path, reason: 'identity-keyed sequence merge conflict' });
          continue;
        }
        if (merged !== 'CLEAN') {
          edits.push({ path, value: merged.value, node: merged.node });
        }
        continue;
      }

      // Scalar/other divergent change — conflict
      conflicts.push({ path, reason: 'divergent modification' });
      continue;
    }

    if (!currentChanged && genChanged) {
      // Only generated changed — apply it
      const currentNode = resolvePath(currentDoc, path);
      if (!currentNode) {
        conflicts.push({ path, reason: 'path not found in current' });
        continue;
      }

      // Check if modifying would lose CST features
      const check = scalarPreservationCheck(currentNode);
      if (!check.ok) {
        conflicts.push({ path, reason: check.reason });
        continue;
      }

      edits.push({ path, value: genValue, node: currentNode, preserveType: check.preserveType });
    }
    // If only current changed — keep current (no edit needed)
  }

  if (conflicts.length > 0) {
    return Object.freeze({
      status: 'CONFLICT',
      bytes: undefined,
      conflicts: Object.freeze(conflicts.map((c) => Object.freeze(c))),
    });
  }

  if (edits.length === 0) {
    // No changes — return current bytes as-is
    return Object.freeze({
      status: 'MERGEABLE',
      bytes: Buffer.from(current),
      conflicts: Object.freeze([]),
    });
  }

  // Apply edits via CST node.range minimal byte replacement.
  // This preserves every byte of current outside the edited token range
  // (indentation, blank lines, EOL comments, anchors, aliases, quoted/block style).
  // If any node lacks a range or the replacement cannot be localised, fail closed.
  const currentSrc = current.toString('utf8');
  /** @type {Array<{ start: number, end: number, replacement: string }>} */
  const byteEdits = [];

  for (const edit of edits) {
    // Locate the leaf value node in currentDoc CST
    const parts = edit.path.split('/').filter(Boolean);
    const leafKey = parts[parts.length - 1];
    const parentPath = parts.slice(0, -1);
    let parentNode = parentPath.length === 0 ? currentDoc.contents : currentDoc;

    for (const part of parentPath) {
      parentNode = parentNode.get(part, true);
      if (!parentNode) break;
    }

    if (!parentNode || !parentNode.items) {
      return Object.freeze({
        status: 'CONFLICT',
        bytes: undefined,
        conflicts: Object.freeze([{
          reason: `cannot locate parent for path '${edit.path}' in CST`,
        }]),
      });
    }

    const pair = parentNode.items.find((item) =>
      item.key && item.key.value === leafKey,
    );
    if (!pair || !pair.value) {
      return Object.freeze({
        status: 'CONFLICT',
        bytes: undefined,
        conflicts: Object.freeze([{
          reason: `cannot locate value node for path '${edit.path}' in CST`,
        }]),
      });
    }

    const valueNode = pair.value;

    // Check for CST features that prevent localised replacement
    const presCheck = scalarPreservationCheck(valueNode);
    if (!presCheck.ok) {
      return Object.freeze({
        status: 'CONFLICT',
        bytes: undefined,
        conflicts: Object.freeze([{ reason: presCheck.reason }]),
      });
    }

    // Get the node's range in the source.  The YAML CST library provides
    // range as [start, end, nodeEnd] when keepSourceTokens is true.
    // We need the value token range specifically.
    const nodeRange = valueNode.range;
    if (!nodeRange || nodeRange.length < 2 || nodeRange[0] == null || nodeRange[1] == null) {
      // Cannot localise — fail closed
      return Object.freeze({
        status: 'CONFLICT',
        bytes: undefined,
        conflicts: Object.freeze([{
          reason: `CST node.range unavailable for path '${edit.path}' — cannot localise edit`,
        }]),
      });
    }

    const rangeStart = nodeRange[0];
    const rangeEnd = nodeRange[1];

    // Only scalar token replacement is proven byte-preserving in v1.
    if (valueNode.items || (edit.value !== null && typeof edit.value === 'object')) {
      return Object.freeze({
        status: 'CONFLICT',
        bytes: undefined,
        conflicts: Object.freeze([{ reason: `non-scalar edit at '${edit.path}' requires manual resolution` }]),
      });
    }

    // Serialise the replacement value preserving the original scalar style.
    let replacementText;
    if (typeof edit.value === 'string') {
      // Preserve quoting style from the original node
      if (valueNode.type === 'QUOTE_DOUBLE') {
        replacementText = JSON.stringify(edit.value);
      } else if (valueNode.type === 'QUOTE_SINGLE') {
        replacementText = `'${edit.value.replaceAll("'", "''")}'`;
      } else if (valueNode.type === 'BLOCK_FOLDED' || valueNode.type === 'BLOCK_LITERAL') {
        return Object.freeze({
          status: 'CONFLICT',
          bytes: undefined,
          conflicts: Object.freeze([{ reason: `block scalar edit at '${edit.path}' requires manual resolution` }]),
        });
      } else {
        replacementText = edit.value;
      }
    } else if (typeof edit.value === 'number' || typeof edit.value === 'boolean') {
      replacementText = String(edit.value);
    } else {
      replacementText = edit.value === null ? 'null' : String(edit.value);
    }

    try {
      const parsedReplacement = YAML.parse(replacementText);
      if (!yamlValueEqual(parsedReplacement, edit.value)) {
        return Object.freeze({
          status: 'CONFLICT',
          bytes: undefined,
          conflicts: Object.freeze([{ reason: `scalar style cannot safely represent value at '${edit.path}'` }]),
        });
      }
    } catch {
      return Object.freeze({
        status: 'CONFLICT',
        bytes: undefined,
        conflicts: Object.freeze([{ reason: `invalid scalar replacement at '${edit.path}'` }]),
      });
    }

    byteEdits.push({ start: rangeStart, end: rangeEnd, replacement: replacementText });
  }

  if (byteEdits.length === 0) {
    return Object.freeze({
      status: 'MERGEABLE',
      bytes: Buffer.from(current),
      conflicts: Object.freeze([]),
    });
  }

  // Apply byte edits in reverse order (highest offset first)
  byteEdits.sort((a, b) => b.start - a.start);

  let output = currentSrc;
  for (const edit of byteEdits) {
    output = output.substring(0, edit.start) + edit.replacement + output.substring(edit.end);
  }

  // Verify preservation: every comment, anchor, and alias from current must survive
  const commentLines = currentSrc.split('\n')
    .filter((line) => line.trimStart().startsWith('#'))
    .map((line) => line.trim());

  for (const comment of commentLines) {
    if (!output.includes(comment)) {
      return Object.freeze({
        status: 'CONFLICT',
        bytes: undefined,
        conflicts: Object.freeze([{
          reason: `comment lost during merge: ${comment}`,
        }]),
      });
    }
  }

  const anchorPattern = /&[\w-]+/g;
  const aliasPattern = /\*[\w-]+/g;
  const anchors = currentSrc.match(anchorPattern) ?? [];
  const aliases = currentSrc.match(aliasPattern) ?? [];

  for (const anchor of anchors) {
    if (!output.includes(anchor)) {
      return Object.freeze({
        status: 'CONFLICT',
        bytes: undefined,
        conflicts: Object.freeze([{
          reason: `anchor lost during merge: ${anchor}`,
        }]),
      });
    }
  }

  for (const alias of aliases) {
    if (!output.includes(alias)) {
      return Object.freeze({
        status: 'CONFLICT',
        bytes: undefined,
        conflicts: Object.freeze([{
          reason: `alias lost during merge: ${alias}`,
        }]),
      });
    }
  }

  return Object.freeze({
    status: 'MERGEABLE',
    bytes: Buffer.from(output, 'utf8'),
    conflicts: Object.freeze([]),
  });
}

// ---------------------------------------------------------------------------
// Identity-keyed sequence merge
// ---------------------------------------------------------------------------

/**
 * Merge a YAML sequence at a given path using an identity key.
 *
 * @param {YAML.Document} baseDoc
 * @param {YAML.Document} currentDoc
 * @param {YAML.Document} genDoc
 * @param {string} path
 * @param {string} identityKey
 * @returns {{ value: any, node: object }|'CLEAN'|'CONFLICT'}
 */
function mergeIdentityKeyedSequence(baseDoc, currentDoc, genDoc, path, identityKey) {
  const parts = path.split('/').filter(Boolean);

  const baseSeq = baseDoc.getIn(parts, true);
  const currentSeq = currentDoc.getIn(parts, true);
  const genSeq = genDoc.getIn(parts, true);

  if (!baseSeq || !currentSeq || !genSeq) return 'CONFLICT';
  if (!baseSeq.items || !currentSeq.items || !genSeq.items) return 'CONFLICT';

  // Index by identity key — each item is a YAMLMap with keys
  const indexBy = (seq) => {
    const map = new Map();
    for (const item of seq.items) {
      if (item.items) {
        const pair = item.items.find((p) => p.key && p.key.value === identityKey);
        if (pair) {
          const keyValue = pair.value?.value ?? pair.value;
          map.set(String(keyValue), item);
        }
      }
    }
    return map;
  };

  const baseMap = indexBy(baseSeq);
  const currentMap = indexBy(currentSeq);
  const genMap = indexBy(genSeq);

  const allKeys = new Set([...baseMap.keys(), ...currentMap.keys(), ...genMap.keys()]);
  const merged = [];

  for (const key of allKeys) {
    const b = baseMap.get(key);
    const c = currentMap.get(key);
    const g = genMap.get(key);

    if (!b && c && g) {
      // Both added — check same
      const cVal = YAML.stringify(c).trim();
      const gVal = YAML.stringify(g).trim();
      if (cVal !== gVal) return 'CONFLICT';
      merged.push(c);
    } else if (!b && c && !g) {
      merged.push(c);
    } else if (!b && !c && g) {
      merged.push(g);
    } else if (b && c && !g) {
      const bVal = YAML.stringify(b).trim();
      const cVal = YAML.stringify(c).trim();
      if (bVal !== cVal) return 'CONFLICT';
      // Producer deleted, human unchanged → accept delete
    } else if (b && !c && g) {
      const bVal = YAML.stringify(b).trim();
      const gVal = YAML.stringify(g).trim();
      if (bVal !== gVal) return 'CONFLICT';
      // Human deleted, producer unchanged → accept delete
    } else if (b && !c && !g) {
      // Both deleted
    } else if (b && c && g) {
      const bVal = YAML.stringify(b).trim();
      const cVal = YAML.stringify(c).trim();
      const gVal = YAML.stringify(g).trim();
      const currChanged = bVal !== cVal;
      const genChanged = bVal !== gVal;
      if (currChanged && genChanged) {
        if (cVal !== gVal) return 'CONFLICT';
        merged.push(c);
      } else if (currChanged) {
        merged.push(c);
      } else if (genChanged) {
        merged.push(g);
      } else {
        merged.push(c);
      }
    }
  }

  // Check if order and content match current
  if (merged.length === currentSeq.items.length) {
    let same = true;
    for (let i = 0; i < merged.length; i++) {
      if (YAML.stringify(merged[i]).trim() !== YAML.stringify(currentSeq.items[i]).trim()) {
        same = false;
        break;
      }
    }
    if (same) return 'CLEAN';
  }

  // Need to reconstruct the sequence value
  const value = merged.map((item) => {
    // Convert YAML node to plain JS value
    try {
      return YAML.parse(YAML.stringify(item));
    } catch {
      return null;
    }
  });

  return { value, node: currentSeq };
}
