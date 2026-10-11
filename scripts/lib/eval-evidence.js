'use strict';

// The sole policy for evidence projection, redaction, and grading artifacts.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assertEvalFile, writeEvalArtifact } = require('./eval-files');
const ROOT = path.join(__dirname, '..', '..');

function parseGrading(raw, expectations) {
  // Grader output may arrive fenced; extract the JSON object and validate shape.
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let g;
  try {
    g = JSON.parse(m[0]);
  } catch {
    return null;
  }
  const results = g.expectations;
  const summary = g.summary;
  const n = Array.isArray(expectations) ? expectations.length : 0;
  if (!n || !Array.isArray(results) || results.length !== n) return null;

  // Validate shape and id binding: every result must carry an integer id in
  // 1..n matching the numbered expectations the grader was given, with no
  // duplicates and no gaps.
  const seenIds = new Set();
  for (const r of results) {
    if (r === null || typeof r !== 'object') return null;
    if (typeof r.text !== 'string' || typeof r.passed !== 'boolean' || typeof r.evidence !== 'string') return null;
    if (!Number.isInteger(r.id) || r.id < 1 || r.id > n) return null;
    if (seenIds.has(r.id)) return null;
    seenIds.add(r.id);
    // The id is the binding; the grader's own wording is advisory. Replace it
    // with the declared expectation so the report always carries the canonical
    // text, even when the grader paraphrased it.
    r.text = expectations[r.id - 1];
  }

  // Derive counters from the validated set; do not trust the grader's summary.
  const passed = results.filter((r) => r.passed === true).length;
  const failed = n - passed;
  const passRate = passed / n;
  if (!summary) return null;
  if (!Number.isInteger(summary.passed) || summary.passed !== passed) return null;
  if (!Number.isInteger(summary.failed) || summary.failed !== failed) return null;
  if (!Number.isInteger(summary.total) || summary.total !== n) return null;
  if (typeof summary.pass_rate !== 'number' || !Number.isFinite(summary.pass_rate)) return null;
  // The integer counters must be exact, but pass_rate is a derived quantity:
  // a grader that rounds or mis-divides it is not reporting a different
  // outcome, so recompute it rather than discarding the whole grading.
  return {
    expectations: results.map(({ id, text, passed: outcome, evidence }) => ({ id, text, passed: outcome, evidence })),
    summary: { passed, failed, total: n, pass_rate: passRate },
  };
}

function extractExecutorModel(trace) {
  for (const line of trace.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === 'system' && event.subtype === 'init') {
        return event.model || null;
      }
    } catch { continue; }
  }
  return null;
}

// Treat CLI output as untrusted. Build a new evidence document rather than
// forwarding transport objects, then apply the same text filter at every sink.
// This minimizes known identifiers; arbitrary project prose is not anonymized.
const PRIVATE_FIELD = /^(?:uuid|session[_-]?id|request[_-]?id|account.*|user[_-]?(?:id|name)|org(?:anization)?.*|email|subscription.*|login.*|thinking|mcp[_-]?servers|plugins|memory[_-]?paths|cwd|.*usage|rate[_-]?limit.*)$/i;
const CREDENTIAL_FIELD = /api[_-]?key|access[_-]?key|authorization|password|passwd|secret|token|cookie|credential|signature/i;
const isPrivateField = key => PRIVATE_FIELD.test(key) || CREDENTIAL_FIELD.test(key) || /socket/i.test(key);
// Detect a keyword independently, then consume one complete key. A pattern
// with variable prefixes and suffixes around that keyword backtracks
// quadratically on long repeated names without a following ':' or '='.
const PRIVATE_TEXT_FIELD = '(?:(?=[a-z0-9_.-]*(?:password|passwd|secret|token|credential|signature|access[_-]?key|api[_-]?key))[a-z0-9_.-]+|authorization|cookie|set[_-]?cookie)';
const PRIVATE_VALUE_PREFIX = String.raw`(?<![?&\w.-])(["']?${PRIVATE_TEXT_FIELD}["']?\s*[:=]\s*)`;
const QUOTED_PRIVATE_VALUE = new RegExp(PRIVATE_VALUE_PREFIX + String.raw`(["'])(?:\\[\s\S]|(?!\2)[^\\])*\2`, 'gi');
const UNTERMINATED_PRIVATE_VALUE = new RegExp(PRIVATE_VALUE_PREFIX + String.raw`(["'])(?:\\[^\r\n]|(?!\2)[^\\\r\n])*(?=\r?$)`, 'gmi');
const UNQUOTED_PRIVATE_VALUE = new RegExp(PRIVATE_VALUE_PREFIX + String.raw`[^\s,;}"']+`, 'gi');
const URL_TEXT = /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]*/gi;
// Do not retry at every '-' or '/' inside a long non-address token. URI
// punctuation overlaps this character set, so handle URL bodies separately.
const EMAIL_ADDRESS = /(?<![a-z0-9.!#$%&'*+/=?^_`{|}~-])[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi;

function scrubEvidenceValue(value, context, depth = 0) {
  if (depth > 32) return '[REDACTED_NESTED_DATA]';
  if (typeof value === 'string') return redactEvidenceText(value, context);
  if (Array.isArray(value)) return value.map((item) => scrubEvidenceValue(item, context, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [redactEvidenceText(key, context), isPrivateField(key) ? '[REDACTED]' : scrubEvidenceValue(item, context, depth + 1)]));
  }
  return value;
}

function tracePrivacyContext(trace, context = {}) {
  const privateValues = new Set(context.privateValues || []);
  const collect = (value) => {
    if (typeof value === 'string' && value.trim()) privateValues.add(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  for (const line of trace.split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (!event || typeof event !== 'object') continue;
    // Dropping a transport container does not make every enum/model/version
    // inside it private. Only collect identity/secret/path values that may be
    // echoed in evidence, never all strings from usage or connection statuses.
    for (const [key, value] of Object.entries(event)) {
      if (isPrivateField(key) && !/(?:usage|rate.?limit|subscription|login)/i.test(key) &&
          typeof value === 'string') collect(value);
      if (/^(?:account|org(?:anization)?)/i.test(key) && value && typeof value === 'object') {
        for (const [field, item] of Object.entries(value)) {
          if (/^(?:id|name|email)$/i.test(field) || isPrivateField(field)) collect(item);
        }
      }
    }
    if (event.memory_paths) collect(event.memory_paths);
    for (const entries of [event.plugins, event.mcp_servers]) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (typeof entry === 'string') collect(entry);
        else if (entry && typeof entry === 'object') { collect(entry.name); collect(entry.path); }
      }
    }
    if (event.message && typeof event.message.id === 'string') collect(event.message.id);
    if (Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block?.type === 'tool_use') collect(block.id);
        if (block?.type === 'tool_result') collect(block.tool_use_id);
      }
    }
  }
  return { ...context, privateValues: [...privateValues].sort((a, b) => b.length - a.length) };
}

function replaceKnownPrivateValue(text, value, replacement) {
  if (typeof value !== 'string' || !value.trim()) return text;
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Unicode token boundaries protect short identities while preserving words
  // that merely contain them; ASCII word boundaries miss non-Latin usernames.
  const left = /^[\p{L}\p{N}_]/u.test(value) ? '(?<![\\p{L}\\p{N}_])' : '';
  const right = /[\p{L}\p{N}_]$/u.test(value) ? '(?![\\p{L}\\p{N}_])' : '';
  return text.replace(new RegExp(left + escaped + right, 'giu'), replacement);
}

function redactQueryValue(match, separator, field, quote) {
  // Signed URLs use vendor-specific names, and query keys can be percent
  // encoded. Decode the key only; keep public URL fields and their spelling.
  let decoded = field;
  try { decoded = decodeURIComponent(field.replace(/\+/g, ' ')); } catch { /* Keep malformed keys literal. */ }
  if (!/^(?:key|auth|sig)$/i.test(decoded) &&
      (!/^[a-z0-9_.-]+$/i.test(decoded) || !CREDENTIAL_FIELD.test(decoded))) return match;
  return `${separator}${field}=${quote || ''}[REDACTED]${quote || ''}`;
}

function redactURLAddress(match) {
  const local = match.slice(0, match.lastIndexOf('@'));
  const delimiter = Math.max(local.lastIndexOf('?'), local.lastIndexOf('&'), local.lastIndexOf('#'));
  const equals = delimiter < 0 ? -1 : local.indexOf('=', delimiter + 1);
  const boundary = delimiter < 0 ? local.lastIndexOf('/') : equals < 0 ? delimiter : equals;
  return match.slice(0, boundary + 1) + '[EMAIL]';
}

function redactURLEmails(url) {
  // Credentials in the authority have already been removed. Apply email
  // redaction only to the remaining path/query/fragment, preserving the host
  // and public fields without repeatedly scanning the preceding document.
  const schemeEnd = url.indexOf('://') + 3;
  const boundary = url.slice(schemeEnd).search(/[/?#]/);
  const authorityEnd = boundary < 0 ? url.length : schemeEnd + boundary;
  // Each URI separator begins a fresh address boundary. Otherwise the '@'
  // consumed from one parameter can prevent matching a later parameter.
  const body = url.slice(authorityEnd).replace(/[/?&#][^/?&#]*/g, component => {
    if (/%[0-9a-f]{2}/i.test(component)) {
      let decoded;
      try { decoded = decodeURIComponent(component); }
      catch {
        // A malformed UTF-8 byte must not hide an otherwise recognizable
        // ASCII email. Decode byte escapes only for classification; the
        // original URL spelling is retained unless a private value is found.
        decoded = component.replace(/%([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
      }
      if (decoded && decoded.match(EMAIL_ADDRESS)) {
        // Preserve the original host and public parameter names. Discard a
        // whole encoded value rather than reconstructing decoded byte offsets
        // or exposing a second address hidden behind encoded separators.
        const equals = component.indexOf('=');
        const field = equals < 0 ? '' : component.slice(1, equals);
        let decodedField = field;
        try { decodedField = decodeURIComponent(field); } catch { /* Keep literal spelling. */ }
        const keepField = /^[?&#]/.test(component) && equals >= 0 && !decodedField.match(EMAIL_ADDRESS);
        return (keepField ? component.slice(0, equals + 1) : component[0]) + '[EMAIL]';
      }
    }
    return component.replace(EMAIL_ADDRESS, redactURLAddress);
  });
  return url.slice(0, authorityEnd) + body;
}

function redactEvidenceText(value, context = {}) {
  let text = String(value);
  // Parse a textual JSON result too: e.g. an auth-status tool response has
  // sensitive field values even though the outer stream event calls it text.
  if (/^\s*[\[{]/.test(text)) {
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { /* Ordinary code/Markdown is handled as text below. */ }
    if (parsed && typeof parsed === 'object') {
      try { return JSON.stringify(scrubEvidenceValue(parsed, context)); }
      catch { return '[REDACTED_UNSUPPORTED_JSON]'; } // Never fall back to valid raw JSON.
    }
  }
  for (const [directory, replacement] of [
    [context.workspace, '<EVAL_WORKSPACE>'], [context.repositoryRoot || ROOT, '<REPOSITORY>'],
    [context.homeDirectory || os.homedir(), '[PRIVATE_HOME]'],
  ]) {
    if (!directory) continue;
    const escaped = directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\\|\//g, '[\\\\/]');
    text = text.replace(new RegExp(escaped, 'gi'), replacement);
  }
  // Strip owner/group columns from long Unix directory listings. They expose
  // identities without containing a home path or an email address.
  text = text.replace(/^(\s*(?:\d+\s*[→:|]\s*)?[bcdlps-][rwxStTs-]{9}[+@.]?\s+\d+\s+)(?:'[^']*'|"[^"]*"|\S+)\s+(?:'[^']*'|"[^"]*"|\S+)(\s+)/gm, '$1[OWNER] [GROUP]$2');
  const usernames = [context.username, process.env.USERNAME, process.env.USER];
  for (const username of usernames) text = replaceKnownPrivateValue(text, username, '[USER]');
  for (const privateValue of context.privateValues || []) {
    text = replaceKnownPrivateValue(text, privateValue, '[REDACTED]');
  }
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[PRIVATE_KEY]')
    .replace(/\b(?:sk-(?:ant-)?[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9]{16,}|github_pat_[a-z0-9_]{20,}|xox[baprs]-[a-z0-9-]{16,})\b/gi, '[CREDENTIAL]')
    .replace(/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^/?#\s"'<>]+@/gi, '$1[CREDENTIAL]@')
    // Cover whole quoted headers, including opaque auth schemes, cookie lists,
    // and escaped quotes. Retain the command URL outside the header argument.
    .replace(/(['"])((?:(?:Proxy-)?Authorization|Cookie|Set-Cookie)\s*[:=]\s*)(?:\\[\s\S]|(?!\1)[^\\])*\1/gi, '$1$2[REDACTED]$1')
    // Malformed quotes have no reliable closing boundary; discard the rest
    // of that line while retaining subsequent verification evidence.
    .replace(/(['"])((?:(?:Proxy-)?Authorization|Cookie|Set-Cookie)\s*[:=]\s*)(?:\\[^\r\n]|(?!\1)[^\\\r\n])*(?=\r?$)/gmi, '$1$2[REDACTED]$1')
    .replace(/((?:Proxy-)?Authorization\s*:\s*)(?:Bearer|Basic)\s+[a-z0-9+/_.=-]+/gi, '$1[CREDENTIAL]')
    .replace(/\b(?:Bearer|Basic)\s+[a-z0-9+/_.=-]{8,}/gi, '[CREDENTIAL]')
    .replace(/^([ \t]*(?:\d+\s*[→:|]\s*)?(?:Cookie|Set-Cookie|(?:Proxy-)?Authorization)\s*[:=]\s*)[^\r\n]*/gmi, '$1[REDACTED]')
    .replace(/\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+\b/gi, '[CREDENTIAL]')
    .replace(/([?&])([^&=\s?#"'<>]+)=(?:(['"])([^\r\n]*?)(?:\3|$)|([^\s&#"'<>]*))/gm, redactQueryValue)
    // Query fields were handled above. Do not let a generic key/value match
    // consume the following public query parameters, or restart inside a key.
    .replace(QUOTED_PRIVATE_VALUE, '$1"[REDACTED]"')
    .replace(UNTERMINATED_PRIVATE_VALUE, '$1"[REDACTED]"')
    .replace(UNQUOTED_PRIVATE_VALUE, '$1[REDACTED]')
    .replace(URL_TEXT, redactURLEmails)
    .replace(EMAIL_ADDRESS, '[EMAIL]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[ID]')
    .replace(/\b(?:session|sess|request|req|msg|toolu|toolcall|org|user)_[a-z0-9_-]{4,}\b/gi, '[ID]')
    .replace(/\\\\\.\\pipe\\[^\s"'<>]+/gi, '[PRIVATE_SOCKET]')
    .replace(/\\\\[^\\/\r\n\s"'<>]+[\\/][^\r\n"'<>]*/g, '[PRIVATE_PATH]')
    .replace(/(^|[\s"'=>(])\/\/[^/\s"'<>]+\/[^\r\n"'<>]*/gm, '$1[PRIVATE_PATH]')
    .replace(/\b[a-z]:[\\/][^\r\n"'<>]*/gi, '[PRIVATE_PATH]')
    .replace(/\/(?:Users|home|root|private|tmp|var|mnt|Volumes)\/(?:[^\r\n"'<>]*)/g, '[PRIVATE_PATH]');
}

const TOOL_INPUT_FIELDS = {
  Skill: ['skill', 'args'],
  Read: ['file_path', 'offset', 'limit', 'pages'],
  Write: ['file_path', 'content'], Edit: ['file_path', 'old_string', 'new_string', 'replace_all'],
  Glob: ['pattern', 'path'],
  Grep: ['pattern', 'path', 'glob', 'output_mode', 'type', '-A', '-B', '-C', '-i', '-n', 'multiline', 'head_limit', 'offset'],
  Bash: ['command', 'description', 'timeout', 'run_in_background'],
  PowerShell: ['command', 'description', 'timeout', 'run_in_background'],
  WebFetch: ['url', 'prompt'], WebSearch: ['query', 'allowed_domains', 'blocked_domains'],
};

function projectTraceForGrading(trace, context = {}) {
  context = tracePrivacyContext(trace, context);
  const evidence = [];
  const calls = new Map();
  const callId = (id) => {
    if (typeof id !== 'string' || !id) return null;
    if (!calls.has(id)) calls.set(id, `call_${calls.size + 1}`);
    return calls.get(id);
  };
  const textBlocks = (content) => {
    if (typeof content === 'string') return redactEvidenceText(content, context);
    if (!Array.isArray(content)) return '';
    return content.filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => ({ type: 'text', text: redactEvidenceText(block.text, context) }));
  };
  for (const line of trace.split('\n')) {
    let event;
    try { event = JSON.parse(line); }
    catch { continue; } // Never fall back to a malformed/raw line.
    if (!event || typeof event !== 'object') continue;
    if (event.type === 'assistant' || event.type === 'user') {
      const message = event.message;
      if (!message || !Array.isArray(message.content)) continue;
      const content = [];
      for (const block of message.content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          content.push({ type: 'text', text: redactEvidenceText(block.text, context) });
        } else if (event.type === 'assistant' && block.type === 'tool_use') {
          const name = Object.hasOwn(TOOL_INPUT_FIELDS, block.name) ? block.name : 'Other';
          const input = {};
          for (const field of TOOL_INPUT_FIELDS[name] || []) {
            if (!block.input || !Object.hasOwn(block.input, field)) continue;
            const value = block.input[field];
            if (typeof value === 'string' || typeof value === 'boolean' ||
                (typeof value === 'number' && Number.isFinite(value)) ||
                (Array.isArray(value) && value.every((item) => typeof item === 'string'))) {
              input[field] = scrubEvidenceValue(value, context);
            }
          }
          content.push({ type: 'tool_use', id: callId(block.id), name, input });
        } else if (event.type === 'user' && block.type === 'tool_result') {
          content.push({ type: 'tool_result', tool_use_id: callId(block.tool_use_id),
            content: textBlocks(block.content), is_error: block.is_error === true });
        }
      }
      if (content.length) evidence.push({ type: event.type, message: { role: event.type, content } });
    } else if (event.type === 'result') {
      const failed = event.is_error === true ||
        (event.is_error !== undefined && typeof event.is_error !== 'boolean') ||
        (typeof event.subtype === 'string' && event.subtype.startsWith('error_'));
      const result = typeof event.result === 'string' ? redactEvidenceText(event.result, context) : '';
      if (failed || result.trim()) evidence.push({ type: 'result', result, is_error: failed });
    }
  }
  return evidence.map((event) => JSON.stringify(event)).join('\n');
}

function assertGradeableTrace(trace) {
  let meaningful = false;
  for (const line of trace.split('\n').filter((item) => item.trim())) {
    const event = JSON.parse(line);
    if (event.type === 'result') {
      if (event.is_error) throw new Error('Executor reported failure');
      meaningful ||= typeof event.result === 'string' && Boolean(event.result.trim());
    } else if (event.type === 'assistant') {
      meaningful ||= event.message.content.some((block) =>
        (block.type === 'text' && Boolean(block.text.trim())) || block.type === 'tool_use');
    } else if (event.type === 'user') {
      meaningful ||= event.message.content.some((block) => block.type === 'tool_result' &&
        (block.is_error || (typeof block.content === 'string' ? Boolean(block.content.trim()) :
          Array.isArray(block.content) && block.content.some((item) => item.text.trim()))));
    }
  }
  if (!meaningful) throw new Error('No supported evidence');
}

function clearGradingSlot(base, candidateTrace = false, root = path.dirname(base)) {
  const files = ['.grading.json', '.grading.raw.txt', '.grading.error.json', ...(candidateTrace ? ['.trace.jsonl'] : [])]
    .map(suffix => base + suffix);
  for (const file of files) assertEvalFile(file, root);
  for (const file of files) fs.rmSync(file, { force: true });
}

function persistGradingOutcome(base, grading, runMeta = null, privacyContext = {}, root = path.dirname(base)) {
  if (!grading) {
    writeEvalArtifact(`${base}.grading.error.json`, JSON.stringify({ error: 'invalid_grading', raw_output_retained: false }) + '\n', root);
    return false;
  }
  const output = {
    expectations: grading.expectations.map(({ id, text, passed, evidence }) => ({
      id, text: redactEvidenceText(text, privacyContext), passed,
      evidence: redactEvidenceText(evidence, privacyContext),
    })),
    summary: {
      passed: grading.summary.passed, failed: grading.summary.failed,
      total: grading.summary.total, pass_rate: grading.summary.pass_rate,
    },
  };
  if (runMeta) {
    output.run = {};
    for (const key of ['executor_model', 'grader_model', 'skill_path', 'installed_skill_path', 'claude_cli_version', 'timestamp']) {
      if (typeof runMeta[key] === 'string') output.run[key] = redactEvidenceText(runMeta[key], privacyContext);
      else if (runMeta[key] === null) output.run[key] = null;
    }
  }
  writeEvalArtifact(`${base}.grading.json`, JSON.stringify(output, null, 2) + '\n', root);
  return true;
}

module.exports = { parseGrading, extractExecutorModel, tracePrivacyContext, redactEvidenceText, projectTraceForGrading, assertGradeableTrace, clearGradingSlot, persistGradingOutcome };
