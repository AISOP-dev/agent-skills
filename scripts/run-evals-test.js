#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { materializeWorkspace, parseGrading, clearGradingSlot, persistGradingOutcome, extractExecutorModel, redactEvidenceText } = require('./run-evals');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeSkill(root, name, description) {
  const dir = path.join(root, 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
  );
}

function behavioralEval(files = ['project/context.txt']) {
  return {
    id: 1,
    prompt: 'Inspect the attached project and complete the requested work.',
    expected_output: 'A verified result grounded in the attached project',
    files,
    expectations: ['The attached project is inspected before reporting a result'],
  };
}

function completeCase(skillName, positivePrompt, topK = 1, files) {
  return {
    skill_name: skillName,
    trigger: {
      positive: [1, 2, 3].map(() => ({ prompt: positivePrompt, top_k: topK })),
      negative: [
        { prompt: 'unrelated banana request' },
        { prompt: 'unrelated orange request' },
      ],
    },
    evals: [behavioralEval(files)],
  };
}

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-skills-run-evals-test-'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'evals', 'cases'), { recursive: true });
  fs.mkdirSync(path.join(root, 'evals', 'fixtures', 'project'), { recursive: true });
  for (const relative of ['scripts/run-evals.js', 'scripts/lib/eval-workspace.js', 'scripts/lib/eval-evidence.js', 'scripts/lib/eval-files.js']) {
    const destination = path.join(root, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', relative), destination);
  }
  fs.writeFileSync(path.join(root, 'evals', 'fixtures', 'project', 'context.txt'), 'fixture\n');
  return root;
}

function run(root, args = []) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'run-evals.js'), ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

test('malformed case JSON reports no excerpt of the input', () => {
  const root = makeSandbox();
  try {
    writeSkill(root, 'alpha-skill', 'Handles alpha widgets. Use when changing alpha widgets.');
    fs.writeFileSync(path.join(root, 'evals', 'cases', 'alpha-skill.json'), 'PRIVATEKEY');
    const result = run(root);
    assert.equal(result.status, 1);
    assert.ok(!`${result.stdout}${result.stderr}`.includes('PRIVATEKEY'), 'JSON syntax errors can embed raw confidential input');
    assert.match(result.stdout, /invalid JSON/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('deterministic routing diagnostics redact private prompt values', () => {
  const root = makeSandbox();
  try {
    writeSkill(root, 'alpha-skill', 'Handles alpha widgets. Use when changing alpha widgets.');
    const evalCase = completeCase('alpha-skill', 'Contact fictional-user@example.invalid with MY_API_KEY=fictionalOpaqueCredentialValue');
    writeJson(path.join(root, 'evals', 'cases', 'alpha-skill.json'), evalCase);
    const result = run(root);
    assert.equal(result.status, 1, 'an unrelated private prompt must fail routing');
    const diagnostics = result.stdout + result.stderr;
    assert.ok(!diagnostics.includes('fictional-user@example.invalid'));
    assert.ok(!diagnostics.includes('fictionalOpaqueCredentialValue'));
    assert.match(diagnostics, /description shares no vocabulary/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const [label, malformed] of [
  ['null case', null],
  ['non-array evals', { ...completeCase('alpha-skill', 'change alpha widget'), evals: {} }],
  ['null eval', { ...completeCase('alpha-skill', 'change alpha widget'), evals: [null] }],
  ['non-array positive triggers', { ...completeCase('alpha-skill', 'change alpha widget'), trigger: { positive: {}, negative: [] } }],
]) {
  test(`deterministic validation rejects ${label} without a private stack trace`, () => {
    const root = makeSandbox();
    try {
      writeSkill(root, 'alpha-skill', 'Handles alpha widgets. Use when changing alpha widgets.');
      writeJson(path.join(root, 'evals', 'cases', 'alpha-skill.json'), malformed);
      const result = run(root);
      assert.equal(result.status, 1);
      assert.ok(!result.stderr.includes(root), 'malformed input must not cause a stack trace with a local directory');
      assert.match(result.stdout, /schema/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

test('accepts a complete and consistent grader result', () => {
  const raw = JSON.stringify({
    expectations: [
      { id: 1, text: 'first expectation', passed: true, evidence: 'observed in the trace' },
      { id: 2, text: 'second expectation', passed: false, evidence: 'not observed in the trace' },
    ],
    summary: { passed: 1, failed: 1, total: 2, pass_rate: 0.5 },
  });

  assert.deepEqual(parseGrading(raw, ['first expectation', 'second expectation']), JSON.parse(raw));
});

test('rejects grader results that omit expectations', () => {
  const raw = JSON.stringify({
    expectations: [
      { id: 1, text: 'first expectation', passed: true, evidence: 'observed in the trace' },
    ],
    summary: { passed: 1, failed: 0, total: 1, pass_rate: 1 },
  });

  assert.equal(parseGrading(raw, ['first expectation', 'second expectation']), null);
});

test('rejects null expectation entries without throwing', () => {
  const cases = [
    { results: [null], declared: ['first expectation'] },
    { results: [{ id: 1, text: 'first expectation', passed: true, evidence: 'observed' }, null], declared: ['first expectation', 'second expectation'] },
  ];
  for (const { results, declared } of cases) {
    const raw = JSON.stringify({
      expectations: results,
      summary: {
        passed: results.length - 1,
        failed: 1,
        total: results.length,
        pass_rate: (results.length - 1) / results.length,
      },
    });

    assert.equal(parseGrading(raw, declared), null);
  }
});

test('rejects incomplete or inconsistent grader summaries', () => {
  const declared = ['expected behavior'];
  const expectation = { id: 1, text: 'expected behavior', passed: false, evidence: 'not observed' };
  const cases = [
    {
      expectations: [],
      summary: { passed: 0, failed: 0, total: 0, pass_rate: 0 },
      declared: [],
    },
    {
      expectations: [{ id: 1, text: 'expected behavior', passed: false }],
      summary: { passed: 0, failed: 1, total: 1, pass_rate: 0 },
      declared,
    },
    {
      expectations: [expectation],
      summary: { passed: 1, failed: 0, total: 1, pass_rate: 1 },
      declared,
    },
    {
      expectations: [expectation],
      summary: { passed: 0, total: 1, pass_rate: 0 },
      declared,
    },
    {
      expectations: [expectation],
      summary: { passed: 0, failed: 1, total: 1 },
      declared,
    },
  ];

  for (const { declared: d, ...grading } of cases) {
    assert.equal(parseGrading(JSON.stringify(grading), d), null);
  }
});

test('fails when a skill has no eval case file', () => {
  const root = makeSandbox();
  writeSkill(root, 'alpha-skill', 'Handles alpha widgets. Use when changing alpha widgets.');

  const result = run(root);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /no eval case file/);
});

test('fails when an eval case is below the required minimums', () => {
  const root = makeSandbox();
  writeSkill(root, 'alpha-skill', 'Handles alpha widgets. Use when changing alpha widgets.');
  writeJson(path.join(root, 'evals', 'cases', 'alpha-skill.json'), {
    skill_name: 'alpha-skill',
    trigger: {
      positive: [{ prompt: 'change alpha widget', top_k: 1 }],
      negative: [],
    },
    evals: [behavioralEval()],
  });

  const result = run(root);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /below required minimums/);
});

test('fails when a behavioral eval references a missing fixture', () => {
  const root = makeSandbox();
  writeSkill(root, 'alpha-skill', 'Handles alpha widgets. Use when changing alpha widgets.');
  writeJson(
    path.join(root, 'evals', 'cases', 'alpha-skill.json'),
    completeCase('alpha-skill', 'change alpha widget', 1, ['missing/project.txt']),
  );

  const result = run(root);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /fixture not found/);
});

test('requires fixtures for execution evals', () => {
  const root = makeSandbox();
  writeSkill(root, 'alpha-skill', 'Handles alpha widgets. Use when changing alpha widgets.');
  writeJson(
    path.join(root, 'evals', 'cases', 'alpha-skill.json'),
    completeCase('alpha-skill', 'change alpha widget', 1, []),
  );

  const result = run(root);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /needs a non-empty files\[\] fixture list/);
});

test('allows dialogue evals without fixtures', () => {
  const root = makeSandbox();
  writeSkill(root, 'alpha-skill', 'Handles alpha widgets. Use when changing alpha widgets.');
  const evalCase = completeCase('alpha-skill', 'change alpha widget');
  evalCase.evals = [{ ...behavioralEval([]), kind: 'dialogue' }];
  writeJson(path.join(root, 'evals', 'cases', 'alpha-skill.json'), evalCase);

  const result = run(root);

  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('rejects provisional execution evals', () => {
  const root = makeSandbox();
  writeSkill(root, 'alpha-skill', 'Handles alpha widgets. Use when changing alpha widgets.');
  const evalCase = completeCase('alpha-skill', 'change alpha widget');
  evalCase.evals[0].trust_level = 'provisional';
  writeJson(path.join(root, 'evals', 'cases', 'alpha-skill.json'), evalCase);

  const result = run(root);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /is still provisional/);
});

test('allows dialogue evals with a legacy provisional marker', () => {
  const root = makeSandbox();
  writeSkill(root, 'alpha-skill', 'Handles alpha widgets. Use when changing alpha widgets.');
  const evalCase = completeCase('alpha-skill', 'change alpha widget');
  evalCase.evals = [{ ...behavioralEval([]), kind: 'dialogue', trust_level: 'provisional' }];
  writeJson(path.join(root, 'evals', 'cases', 'alpha-skill.json'), evalCase);

  const result = run(root);

  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('rejects unknown behavioral eval kinds', () => {
  const root = makeSandbox();
  writeSkill(root, 'alpha-skill', 'Handles alpha widgets. Use when changing alpha widgets.');
  const evalCase = completeCase('alpha-skill', 'change alpha widget');
  evalCase.evals[0].kind = 'conversation';
  writeJson(path.join(root, 'evals', 'cases', 'alpha-skill.json'), evalCase);

  const result = run(root);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /unknown kind "conversation"/);
});

test('dry-runs a fixtureless dialogue eval', () => {
  const root = makeSandbox();
  writeSkill(root, 'alpha-skill', 'Handles alpha widgets. Use when changing alpha widgets.');
  const evalCase = completeCase('alpha-skill', 'change alpha widget');
  evalCase.evals = [{ ...behavioralEval([]), kind: 'dialogue' }];
  writeJson(path.join(root, 'evals', 'cases', 'alpha-skill.json'), evalCase);

  const result = run(root, ['--behavioral', 'alpha-skill', '--dry-run']);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /dialogue transcript/);
});

test('enforces the configured rank-1 floor', () => {
  const root = makeSandbox();
  writeSkill(root, 'alpha-skill', 'Handles widget work. Use when implementing widget changes.');
  writeSkill(
    root,
    'beta-skill',
    'Diagnoses urgent widget failures in production. Use when repairing urgent widget failures.',
  );
  writeJson(
    path.join(root, 'evals', 'cases', 'alpha-skill.json'),
    completeCase('alpha-skill', 'urgent widget failure production', 2),
  );
  writeJson(
    path.join(root, 'evals', 'cases', 'beta-skill.json'),
    completeCase('beta-skill', 'repair urgent widget failure', 1),
  );

  const passing = run(root, ['--min-rank1', '50']);
  const failing = run(root, ['--min-rank1', '60']);

  assert.equal(passing.status, 0, passing.stdout + passing.stderr);
  assert.equal(failing.status, 1, failing.stdout + failing.stderr);
  assert.match(failing.stdout, /below required 60%/);
});

test('rejects an invalid rank-1 floor', () => {
  const root = makeSandbox();

  const result = run(root, ['--min-rank1', '101']);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /--min-rank1 must be a number from 0 to 100/);
});

// ---------- parseGrading expectation-binding tests ----------

test('accepts reordered-but-complete grader results', () => {
  const expectations = ['first expectation', 'second expectation'];
  const raw = JSON.stringify({
    expectations: [
      { id: 2, text: 'second expectation', passed: false, evidence: 'not observed' },
      { id: 1, text: 'first expectation', passed: true, evidence: 'observed in the trace' },
    ],
    summary: { passed: 1, failed: 1, total: 2, pass_rate: 0.5 },
  });
  const result = parseGrading(raw, expectations);
  assert.notEqual(result, null);
  assert.equal(result.summary.passed, 1);
  assert.equal(result.summary.failed, 1);
});

test('rejects duplicate grader results for the same expectation', () => {
  const expectations = ['first expectation', 'second expectation'];
  // Valid baseline: each id appears exactly once
  const validRaw = JSON.stringify({
    expectations: [
      { id: 1, text: 'first expectation', passed: true, evidence: 'observed' },
      { id: 2, text: 'second expectation', passed: false, evidence: 'not observed' },
    ],
    summary: { passed: 1, failed: 1, total: 2, pass_rate: 0.5 },
  });
  assert.notEqual(parseGrading(validRaw, expectations), null);

  // Duplicate: id 1 appears twice, id 2 is missing
  const dupRaw = JSON.stringify({
    expectations: [
      { id: 1, text: 'first expectation', passed: true, evidence: 'observed' },
      { id: 1, text: 'first expectation', passed: true, evidence: 'observed again' },
    ],
    summary: { passed: 2, failed: 0, total: 2, pass_rate: 1 },
  });
  assert.equal(parseGrading(dupRaw, expectations), null);
});

test('rejects grader results whose ids are not in the declared set', () => {
  const expectations = ['first expectation', 'second expectation'];
  // Valid baseline
  const validRaw = JSON.stringify({
    expectations: [
      { id: 1, text: 'first expectation', passed: true, evidence: 'observed' },
      { id: 2, text: 'second expectation', passed: false, evidence: 'not observed' },
    ],
    summary: { passed: 1, failed: 1, total: 2, pass_rate: 0.5 },
  });
  assert.notEqual(parseGrading(validRaw, expectations), null);

  // id 3 is out of range 1..2
  const badIdRaw = JSON.stringify({
    expectations: [
      { id: 1, text: 'first expectation', passed: true, evidence: 'observed' },
      { id: 3, text: 'unknown expectation', passed: false, evidence: 'not found' },
    ],
    summary: { passed: 1, failed: 1, total: 2, pass_rate: 0.5 },
  });
  assert.equal(parseGrading(badIdRaw, expectations), null);
});

test('rejects a result set that omits a declared expectation', () => {
  const expectations = ['first expectation', 'second expectation', 'third expectation'];
  // Valid baseline
  const validRaw = JSON.stringify({
    expectations: [
      { id: 1, text: 'first expectation', passed: true, evidence: 'observed' },
      { id: 2, text: 'second expectation', passed: true, evidence: 'observed' },
      { id: 3, text: 'third expectation', passed: false, evidence: 'not observed' },
    ],
    summary: { passed: 2, failed: 1, total: 3, pass_rate: 2 / 3 },
  });
  assert.notEqual(parseGrading(validRaw, expectations), null);

  // Only 2 results for 3 expectations (id 3 omitted)
  const partialRaw = JSON.stringify({
    expectations: [
      { id: 1, text: 'first expectation', passed: true, evidence: 'observed' },
      { id: 2, text: 'second expectation', passed: true, evidence: 'observed' },
    ],
    summary: { passed: 2, failed: 0, total: 2, pass_rate: 1 },
  });
  assert.equal(parseGrading(partialRaw, expectations), null);
});

test('derives pass_rate from counters rather than trusting the grader value', () => {
  const expectations = ['first expectation', 'second expectation'];
  // Correct pass_rate should be accepted
  const validRaw = JSON.stringify({
    expectations: [
      { id: 1, text: 'first expectation', passed: true, evidence: 'observed' },
      { id: 2, text: 'second expectation', passed: false, evidence: 'not observed' },
    ],
    summary: { passed: 1, failed: 1, total: 2, pass_rate: 0.5 },
  });
  const valid = parseGrading(validRaw, expectations);
  assert.notEqual(valid, null);
  assert.equal(valid.summary.pass_rate, 0.5);

  // Wrong pass_rate with correct counters: accepted, but recomputed
  const wrongRaw = JSON.stringify({
    expectations: [
      { id: 1, text: 'first expectation', passed: true, evidence: 'observed' },
      { id: 2, text: 'second expectation', passed: false, evidence: 'not observed' },
    ],
    summary: { passed: 1, failed: 1, total: 2, pass_rate: 0.999 },
  });
  const corrected = parseGrading(wrongRaw, expectations);
  assert.notEqual(corrected, null);
  assert.equal(corrected.summary.pass_rate, 0.5);
  // The integer counters stay exact checks
  assert.equal(corrected.summary.passed, 1);
  assert.equal(corrected.summary.failed, 1);
});

test('replaces paraphrased grader text with the declared expectation', () => {
  const expectations = ['first expectation', 'second expectation'];
  const raw = JSON.stringify({
    expectations: [
      { id: 2, text: 'the agent did the second thing', passed: false, evidence: 'not observed' },
      { id: 1, text: 'roughly the first one', passed: true, evidence: 'observed' },
    ],
    summary: { passed: 1, failed: 1, total: 2, pass_rate: 0.5 },
  });

  const result = parseGrading(raw, expectations);
  assert.notEqual(result, null);
  assert.equal(result.expectations.find((r) => r.id === 1).text, 'first expectation');
  assert.equal(result.expectations.find((r) => r.id === 2).text, 'second expectation');
});

// ---------- persistGradingOutcome stale-cleanup tests ----------

test('rejected grading writes a generic diagnostic without retaining raw output', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grading-cleanup-'));
  try {
    const base = path.join(dir, 'my-skill.eval-1');

    const result = persistGradingOutcome(base, parseGrading('unparseable grader output', ['x']));

    assert.equal(result, false);
    assert.equal(fs.existsSync(`${base}.grading.raw.txt`), false, 'raw output must not be written');
    assert.deepEqual(JSON.parse(fs.readFileSync(`${base}.grading.error.json`, 'utf8')),
      { error: 'invalid_grading', raw_output_retained: false });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rejected grading succeeds even when no prior grading.json exists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grading-cleanup-'));
  try {
    const base = path.join(dir, 'my-skill.eval-1');

    const result = persistGradingOutcome(base, parseGrading('bad output', ['x']));

    assert.equal(result, false);
    assert.equal(fs.existsSync(`${base}.grading.raw.txt`), false);
    assert.equal(fs.existsSync(`${base}.grading.error.json`), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('grader projection excludes unrequested fields at every level', () => {
  const grading = {
    expectations: [{ id: 1, text: 'expected', passed: true, evidence: 'observed', private_note: 'fictional-private-note' }],
    summary: { passed: 1, failed: 0, total: 1, pass_rate: 1, session_id: 'fictional-session' },
    account: 'fictional-account',
  };
  const parsed = parseGrading(JSON.stringify(grading), ['expected']);
  assert.deepEqual(Object.keys(parsed).sort(), ['expectations', 'summary']);
  assert.deepEqual(Object.keys(parsed.expectations[0]).sort(), ['evidence', 'id', 'passed', 'text']);
  assert.deepEqual(Object.keys(parsed.summary).sort(), ['failed', 'pass_rate', 'passed', 'total']);
});

test('redacts URL userinfo and short authorization credentials in command evidence', () => {
  // These are deliberately fictional values, never account credentials.
  const context = { homeDirectory: '/home/fictional-private-user', username: 'fictional-private-user' };
  const url = redactEvidenceText('Fetch https://fictional-login:fictional-pass@service.example.invalid/public', context);
  assert.ok(!url.includes('fictional-login') && !url.includes('fictional-pass'), 'URL login and password must be withheld');
  assert.ok(url.includes('service.example.invalid/public'), 'the public request destination must remain visible');
  const command = redactEvidenceText('curl -H "Authorization: Basic YTpi" https://service.example.invalid', context);
  assert.ok(!command.includes('YTpi'), 'short header credentials must not bypass the text filter');
});

test('accepted grading writes grading.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grading-cleanup-'));
  try {
    const base = path.join(dir, 'my-skill.eval-1');
    const grading = {
      expectations: [{ id: 1, text: 'x', passed: true, evidence: 'y' }],
      summary: { passed: 1, failed: 0, total: 1, pass_rate: 1 },
    };

    const result = persistGradingOutcome(base, grading);

    assert.equal(result, true);
    const written = JSON.parse(fs.readFileSync(`${base}.grading.json`, 'utf8'));
    assert.deepEqual(written, grading);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- upfront slot-clearing tests ----------

test('a grader that throws leaves no result file behind', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grading-crash-'));
  try {
    const base = path.join(dir, 'my-skill.eval-1');
    // Stale files from a prior run
    fs.writeFileSync(`${base}.grading.json`, '{"previous":"run"}\n');
    fs.writeFileSync(`${base}.grading.raw.txt`, 'previous raw output');
    fs.writeFileSync(`${base}.trace.jsonl`, 'previous trace');

    clearGradingSlot(base, true);

    // Executor or grader crashes — persistGradingOutcome is never called

    assert.equal(fs.existsSync(`${base}.grading.json`), false, 'stale grading.json must not survive a crash');
    assert.equal(fs.existsSync(`${base}.grading.raw.txt`), false, 'stale grading.raw.txt must not survive a crash');
    assert.equal(fs.existsSync(`${base}.trace.jsonl`), false, 'stale execution trace must not survive a crash');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('successful grading leaves no stale raw file behind', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grading-success-'));
  try {
    const base = path.join(dir, 'my-skill.eval-1');
    // Stale raw from a prior rejected run
    fs.writeFileSync(`${base}.grading.raw.txt`, 'previous raw output');

    clearGradingSlot(base);

    // Successful grading
    const grading = {
      expectations: [{ id: 1, text: 'x', passed: true, evidence: 'y' }],
      summary: { passed: 1, failed: 0, total: 1, pass_rate: 1 },
    };
    persistGradingOutcome(base, grading);

    assert.equal(fs.existsSync(`${base}.grading.json`), true, 'grading.json must be written');
    assert.equal(fs.existsSync(`${base}.grading.raw.txt`), false, 'stale grading.raw.txt must not survive');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- extractExecutorModel tests ----------

test('extracts model from the stream-json init event', () => {
  const trace = [
    '{"type":"system","subtype":"init","model":"claude-sonnet-4-6-20250514","session_id":"abc"}',
    '{"type":"assistant","message":{"id":"msg_1","content":[{"type":"text","text":"Hi"}]}}',
    '{"type":"result","subtype":"success","result":"Hi"}',
  ].join('\n');

  assert.equal(extractExecutorModel(trace), 'claude-sonnet-4-6-20250514');
});

test('returns null when the trace has no init event', () => {
  const trace = [
    '{"type":"assistant","message":{"id":"msg_1","content":[]}}',
    '{"type":"result","subtype":"success","result":"done"}',
  ].join('\n');

  assert.equal(extractExecutorModel(trace), null);
});

test('returns null when the init event has no model field', () => {
  const trace = '{"type":"system","subtype":"init","session_id":"abc"}\n';

  assert.equal(extractExecutorModel(trace), null);
});

test('tolerates non-JSON lines in the trace', () => {
  const trace = [
    'not json',
    '{"type":"system","subtype":"init","model":"claude-opus-4-6","session_id":"abc"}',
  ].join('\n');

  assert.equal(extractExecutorModel(trace), 'claude-opus-4-6');
});

// ---------- persistGradingOutcome run identity tests ----------

test('accepted grading includes run metadata when provided', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grading-run-meta-'));
  try {
    const base = path.join(dir, 'my-skill.eval-1');
    const grading = {
      expectations: [{ id: 1, text: 'x', passed: true, evidence: 'y' }],
      summary: { passed: 1, failed: 0, total: 1, pass_rate: 1 },
    };
    const runMeta = {
      executor_model: 'claude-sonnet-4-6-20250514',
      grader_model: 'unknown',
      timestamp: '2026-09-21T00:00:00.000Z',
    };

    persistGradingOutcome(base, grading, runMeta);

    const written = JSON.parse(fs.readFileSync(`${base}.grading.json`, 'utf8'));
    assert.deepEqual(written.run, runMeta);
    assert.deepEqual(written.expectations, grading.expectations);
    assert.deepEqual(written.summary, grading.summary);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('accepted grading omits run key when no metadata is provided', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grading-no-meta-'));
  try {
    const base = path.join(dir, 'my-skill.eval-1');
    const grading = {
      expectations: [{ id: 1, text: 'x', passed: true, evidence: 'y' }],
      summary: { passed: 1, failed: 0, total: 1, pass_rate: 1 },
    };

    persistGradingOutcome(base, grading);

    const written = JSON.parse(fs.readFileSync(`${base}.grading.json`, 'utf8'));
    assert.equal('run' in written, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('materializes a git baseline and applies a working-tree patch', () => {
  const workspace = materializeWorkspace({ files: ['git-workflow-and-versioning'] });
  try {
    const status = spawnSync('git', ['status', '--short'], { cwd: workspace, encoding: 'utf8' });
    const commits = spawnSync('git', ['rev-list', '--count', 'HEAD'], { cwd: workspace, encoding: 'utf8' });

    assert.equal(status.status, 0, status.stdout + status.stderr);
    assert.match(status.stdout, / M git-workflow-and-versioning\/app\.js/);
    assert.equal(commits.stdout.trim(), '1');
    assert.equal(fs.existsSync(path.join(workspace, '.eval')), false);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('refuses fixture-supplied root Git metadata before repository initialization', () => {
  const root = makeSandbox();
  let workspace;
  try {
    fs.mkdirSync(path.join(root, 'evals', 'fixtures', '.git'));
    fs.writeFileSync(path.join(root, 'evals', 'fixtures', '.git', 'config'), '');
    const runner = require(path.join(root, 'scripts', 'run-evals.js'));
    for (const selector of ['.git', './.git', 'folder/../.git']) {
      assert.throws(() => { workspace = runner.materializeWorkspace(behavioralEval(['project/context.txt', selector])); },
        /reserved.*\.git/);
    }
  } finally {
    if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('does not overwrite a grading file that is hardlinked to another record', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grading-linked-test-'));
  try {
    const original = path.join(root, 'unrelated-record.json');
    const base = path.join(root, 'alpha.eval-1');
    fs.writeFileSync(original, 'FICTIONAL_UNRELATED_RECORD\n');
    fs.linkSync(original, `${base}.grading.json`);
    const grading = {
      expectations: [{ id: 1, text: 'expected', passed: true, evidence: 'observed' }],
      summary: { passed: 1, failed: 0, total: 1, pass_rate: 1 },
    };
    assert.throws(() => persistGradingOutcome(base, grading), /linked|unsafe/i);
    assert.equal(fs.readFileSync(original, 'utf8'), 'FICTIONAL_UNRELATED_RECORD\n');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an interrupted artifact replacement preserves the prior record and removes its temporary file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grading-atomic-test-'));
  const rename = fs.renameSync;
  try {
    const { writeEvalArtifact } = require('./lib/eval-files');
    const file = path.join(root, 'grade.json');
    fs.writeFileSync(file, 'PRIOR_FICTIONAL_RECORD\n');
    fs.renameSync = () => { throw new Error('Simulated replacement failure'); };
    assert.throws(() => writeEvalArtifact(file, 'NEXT_FICTIONAL_RECORD\n'), /Simulated replacement failure/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'PRIOR_FICTIONAL_RECORD\n');
    assert.deepEqual(fs.readdirSync(root), ['grade.json']);
  } finally {
    fs.renameSync = rename;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an exclusive artifact-open collision does not delete a file created by another writer', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grading-collision-test-'));
  const open = fs.openSync;
  const write = fs.writeFileSync;
  let collision;
  try {
    const { writeEvalArtifact } = require('./lib/eval-files');
    fs.openSync = (file, flags, mode) => {
      if (flags !== 'wx') return open(file, flags, mode);
      collision = file;
      write(file, 'FICTIONAL_COMPETING_WRITER\n');
      const error = new Error('Simulated exclusive-open collision');
      error.code = 'EEXIST';
      throw error;
    };
    assert.throws(() => writeEvalArtifact(path.join(root, 'grade.json'), 'NEXT_FICTIONAL_RECORD\n'), /collision/);
    assert.equal(fs.readFileSync(collision, 'utf8'), 'FICTIONAL_COMPETING_WRITER\n');
    assert.equal(fs.existsSync(path.join(root, 'grade.json')), false);
  } finally {
    fs.openSync = open;
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('fixture baseline commits ignore inherited user signing requirements', () => {
  const root = makeSandbox();
  const config = path.join(root, 'global.gitconfig');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-signing-test-'));
  try {
    fs.writeFileSync(config, '[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = definitely-missing-eval-signer\n');
    const result = spawnSync(process.execPath, ['-e', `
      const fs = require('node:fs');
      const { materializeWorkspace } = require(${JSON.stringify(path.join(root, 'scripts', 'run-evals.js'))});
      let workspace;
      try { workspace = materializeWorkspace({ files: ['project/context.txt'] }); }
      finally { if (workspace) fs.rmSync(workspace, { recursive: true, force: true }); }
    `], { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: config, TMPDIR: temp, TMP: temp, TEMP: temp } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('rejects duplicate behavioral IDs before they can overwrite a grading slot', () => {
  const root = makeSandbox();
  try {
    writeSkill(root, 'alpha-skill', 'Handles alpha widgets. Use when changing alpha widgets.');
    const evalCase = completeCase('alpha-skill', 'change alpha widget');
    evalCase.evals.push({ ...behavioralEval(), prompt: 'A different evaluation' });
    writeJson(path.join(root, 'evals', 'cases', 'alpha-skill.json'), evalCase);
    const result = run(root);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /duplicate behavioral eval id=1/);
    const dryRun = run(root, ['--behavioral', 'alpha-skill', '--dry-run']);
    assert.equal(dryRun.status, 1, dryRun.stdout + dryRun.stderr);
    assert.match(dryRun.stderr, /duplicate behavioral eval id=1/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('accepts distinct behavioral IDs including zero', () => {
  const root = makeSandbox();
  try {
    writeSkill(root, 'alpha-skill', 'Handles alpha widgets. Use when changing alpha widgets.');
    const evalCase = completeCase('alpha-skill', 'change alpha widget');
    evalCase.evals.push({ ...behavioralEval(), id: 0 });
    writeJson(path.join(root, 'evals', 'cases', 'alpha-skill.json'), evalCase);
    const result = run(root);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('removes the throwaway workspace when fixture setup fails', () => {
  const root = makeSandbox();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-cleanup-test-'));
  try {
    const result = spawnSync(process.execPath, ['-e', `
      const { materializeWorkspace } = require(${JSON.stringify(path.join(root, 'scripts', 'run-evals.js'))});
      try { materializeWorkspace({ files: ['project/context.txt', 'missing.txt'] }); }
      catch (error) { console.error(error.message); }
    `], { cwd: root, encoding: 'utf8', env: { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /fixture listed in files\[\] not found/);
    assert.deepEqual(fs.readdirSync(temp), [], 'partially copied fixture data must be removed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

// Candidate bundles are opt-in; the same independent cases exercise the
// installed bridge and its supporting files instead of embedding the JSON.
function writeCandidate(root, name = 'alpha-skill') {
  const relative = 'experiments/candidate';
  const directory = path.join(root, relative);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Handles alpha widgets. Use when changing alpha widgets.\n---\n\nRead program.json relative to this skill directory.\n`);
  writeJson(path.join(directory, 'program.json'), { instruction: 'canonical-only-marker' });
  writeJson(path.join(directory, 'eval-bundle.json'), { files: ['SKILL.md', 'program.json'] });
  writeSkill(root, 'alpha-skill', 'Handles alpha widgets. Use when changing alpha widgets.');
  writeJson(path.join(root, 'evals', 'cases', 'alpha-skill.json'),
    completeCase('alpha-skill', 'change alpha widget'));
  return relative;
}

test('--skill-dir requires behavioral mode and exactly one directory value', () => {
  const root = makeSandbox();
  try {
    const relative = writeCandidate(root);
    for (const args of [
      ['--skill-dir', relative],
      ['--behavioral', 'alpha-skill', '--skill-dir', '--dry-run'],
      ['--behavioral', 'alpha-skill', '--skill-dir', relative, '--skill-dir', relative, '--dry-run'],
    ]) {
      const result = run(root, args);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /--skill-dir/);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('candidate dry-run identifies its isolated source and results; baseline stays unchanged', () => {
  const root = makeSandbox();
  try {
    const relative = writeCandidate(root);
    const candidate = run(root, ['--behavioral', 'alpha-skill', '--skill-dir', relative, '--dry-run']);
    assert.equal(candidate.status, 0, candidate.stdout + candidate.stderr);
    assert.match(candidate.stdout, /experiments\/candidate\/SKILL\.md/);
    assert.match(candidate.stdout, /evals\/results\/skill-dir\/experiments\/candidate/);
    assert.match(candidate.stdout, /\.eval-skills\/alpha-skill/);
    assert.equal(fs.existsSync(path.join(root, 'evals', 'results')), false);
    const baseline = run(root, ['--behavioral', 'alpha-skill', '--dry-run']);
    assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
    assert.match(baseline.stdout, /<alpha-skill\/SKILL\.md>/);
    assert.doesNotMatch(baseline.stdout, /skill-dir|\.eval-skills|experiments\/candidate/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('loads candidate frontmatter with a UTF-8 BOM and CRLF line endings', () => {
  const root = makeSandbox();
  try {
    const relative = writeCandidate(root);
    const file = path.join(root, relative, 'SKILL.md');
    const content = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, `\uFEFF${content.replace(/\n/g, '\r\n')}`);
    const result = run(root, ['--behavioral', 'alpha-skill', '--skill-dir', relative, '--dry-run']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /experiments\/candidate\/SKILL\.md/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('rejects escaping, missing, and mismatched candidate directories before execution', () => {
  const root = makeSandbox();
  try {
    const relative = writeCandidate(root, 'different-skill');
    for (const [directory, error] of [
      ['../outside', /relative|escape/],
      [path.resolve(root, relative), /relative/],
      ['missing', /directory|ENOENT/],
      [relative, /name.*alpha-skill/],
    ]) {
      const result = run(root, ['--behavioral', 'alpha-skill', '--skill-dir', directory, '--dry-run']);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, error);
    }
    fs.unlinkSync(path.join(root, relative, 'SKILL.md'));
    const missing = run(root, ['--behavioral', 'alpha-skill', '--skill-dir', relative, '--dry-run']);
    assert.equal(missing.status, 1, missing.stdout + missing.stderr);
    assert.match(missing.stderr, /SKILL\.md/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('rejects a symlink in a candidate bundle and a symlinked candidate directory', () => {
  const root = makeSandbox();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-outside-'));
  try {
    const relative = writeCandidate(root);
    fs.symlinkSync(outside, path.join(root, relative, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const linkedFile = run(root, ['--behavioral', 'alpha-skill', '--skill-dir', relative, '--dry-run']);
    assert.equal(linkedFile.status, 1, linkedFile.stdout + linkedFile.stderr);
    assert.match(linkedFile.stderr, /symlink/);
    fs.symlinkSync(outside, path.join(root, 'linked-candidate'), process.platform === 'win32' ? 'junction' : 'dir');
    const linkedDir = run(root, ['--behavioral', 'alpha-skill', '--skill-dir', 'linked-candidate', '--dry-run']);
    assert.equal(linkedDir.status, 1, linkedDir.stdout + linkedDir.stderr);
    assert.match(linkedDir.stderr, /symlink|escape/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('materializes a relocated candidate bundle whose JSON can be read from the installed bridge path', () => {
  const root = makeSandbox();
  let workspace;
  try {
    const relative = writeCandidate(root);
    const runner = require(path.join(root, 'scripts', 'run-evals.js'));
    const bundle = runner.loadSkillBundle('alpha-skill', relative);
    workspace = runner.materializeWorkspace(behavioralEval(), bundle);
    const installed = path.join(workspace, '.eval-skills', 'alpha-skill', 'SKILL.md');
    const canonical = JSON.parse(fs.readFileSync(path.join(path.dirname(installed), 'program.json'), 'utf8'));
    assert.equal(canonical.instruction, 'canonical-only-marker');
    const prompt = runner.skillSystemPrompt(installed, workspace);
    assert.match(prompt, /Read program\.json/);
    assert.ok(prompt.includes('.eval-skills/alpha-skill/SKILL.md'));
    assert.ok(!prompt.includes(workspace), 'system prompt must omit the absolute workspace');
    assert.doesNotMatch(prompt, /canonical-only-marker/);
    const status = spawnSync('git', ['status', '--short'], { cwd: workspace, encoding: 'utf8' });
    assert.equal(status.stdout, '', 'installed evaluation instructions must not pollute fixture changes');
  } finally {
    if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('candidate staging copies only manifest files, excluding undeclared and hidden data', () => {
  const root = makeSandbox();
  let workspace;
  try {
    const relative = writeCandidate(root);
    const directory = path.join(root, relative);
    fs.writeFileSync(path.join(directory, '.env'), 'fictional-private-setting');
    fs.writeFileSync(path.join(directory, 'unlisted.txt'), 'fictional-private-note');
    const runner = require(path.join(root, 'scripts', 'run-evals.js'));
    workspace = runner.materializeWorkspace(behavioralEval(), runner.loadSkillBundle('alpha-skill', relative));
    assert.deepEqual(fs.readdirSync(path.join(workspace, '.eval-skills', 'alpha-skill')).sort(),
      ['SKILL.md', 'program.json']);
  } finally {
    if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('candidate manifests reject missing, escaping, duplicate, and sensitive entries', () => {
  const root = makeSandbox();
  try {
    const relative = writeCandidate(root);
    const directory = path.join(root, relative);
    const runner = require(path.join(root, 'scripts', 'run-evals.js'));
    fs.writeFileSync(path.join(directory, '.env'), 'fictional-private-setting');
    fs.mkdirSync(path.join(directory, 'notes'));
    fs.writeFileSync(path.join(directory, 'notes', 'credentials.json'), '{}');
    for (const files of [
      [], ['program.json'], ['SKILL.md', '../outside.md'],
      ['SKILL.md', 'SKILL.md'], ['SKILL.md', '.env'],
      ['SKILL.md', 'notes/credentials.json'], ['SKILL.md', 'notes'],
      ['SKILL.md', 'missing.md'], ['SKILL.md', 'notes/../SKILL.md'],
      ['SKILL.md', 'C:\\outside.md'],
    ]) {
      writeJson(path.join(directory, 'eval-bundle.json'), { files });
      assert.throws(() => runner.loadSkillBundle('alpha-skill', relative));
    }
    fs.unlinkSync(path.join(directory, 'eval-bundle.json'));
    assert.throws(() => runner.loadSkillBundle('alpha-skill', relative), /manifest|eval-bundle/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('rejects fixture data that pre-populates the reserved candidate directory', () => {
  const root = makeSandbox();
  let workspace;
  try {
    const relative = writeCandidate(root);
    writeJson(path.join(root, 'evals', 'fixtures', '.eval-skills', 'alpha-skill', 'program.json'),
      { instruction: 'forged-fixture' });
    const runner = require(path.join(root, 'scripts', 'run-evals.js'));
    const bundle = runner.loadSkillBundle('alpha-skill', relative);
    assert.throws(() => {
      workspace = runner.materializeWorkspace(behavioralEval(['.eval-skills']), bundle);
    }, /reserved.*\.eval-skills/);
  } finally {
    if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('candidate behavioral execution loads the installed package and records source and CLI version', () => {
  const root = makeSandbox();
  try {
    const relative = writeCandidate(root);
    const result = spawnSync(process.execPath, ['-e', `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const path = require('node:path');
      const cp = require('node:child_process');
      const original = cp.execFileSync;
      cp.execFileSync = (command, args, options) => {
        if (command !== 'claude') return original(command, args, options);
        if (args.includes('--version')) return 'test-cli-version\\n';
        const promptIndex = args.indexOf('--append-system-prompt');
        if (promptIndex !== -1) {
          const installed = path.join(options.cwd, '.eval-skills', 'alpha-skill', 'SKILL.md');
          assert.ok(args[promptIndex + 1].includes('.eval-skills/alpha-skill/SKILL.md'));
          assert.ok(!args[promptIndex + 1].includes(options.cwd));
          assert.ok(!args[promptIndex + 1].includes('canonical-only-marker'));
          const json = fs.readFileSync(path.join(path.dirname(installed), 'program.json'), 'utf8');
          assert.ok(json.includes('canonical-only-marker'));
          return [
            JSON.stringify({ type: 'system', subtype: 'init', model: 'test-model' }),
            JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Read fixture' }] } }),
          ].join('\\n');
        }
        return JSON.stringify({
          expectations: [{ id: 1, text: 'The attached project is inspected before reporting a result', passed: true, evidence: 'Read fixture' }],
          summary: { passed: 1, failed: 0, total: 1, pass_rate: 1 }
        });
      };
      require(${JSON.stringify(path.join(root, 'scripts', 'run-evals.js'))}).runBehavioral('alpha-skill', false, ${JSON.stringify(relative)});
    `], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const file = path.join(root, 'evals', 'results', 'skill-dir', relative, 'alpha-skill.eval-1.grading.json');
    const grading = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(grading.run.skill_path, `${relative}/SKILL.md`);
    assert.equal(grading.run.claude_cli_version, 'test-cli-version');
    assert.equal(grading.run.executor_model, 'test-model');
    const trace = fs.readFileSync(file.replace('.grading.json', '.trace.jsonl'), 'utf8');
    assert.ok(trace.includes('Read fixture'));
    assert.ok(!trace.includes('init') && !trace.includes('test-model'));
    assert.equal(grading.run.installed_skill_path, '.eval-skills/alpha-skill/SKILL.md');
    assert.equal(fs.existsSync(path.join(root, 'evals', 'results', 'alpha-skill.eval-1.grading.json')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const executionSucceeds of [false, true]) {
  test(`version probe failure is best-effort when behavioral execution ${executionSucceeds ? 'succeeds' : 'fails'}`, () => {
    const root = makeSandbox();
    try {
      const relative = writeCandidate(root);
      const base = path.join(root, 'evals', 'results', 'skill-dir', relative, 'alpha-skill.eval-1');
      fs.mkdirSync(path.dirname(base), { recursive: true });
      fs.writeFileSync(`${base}.grading.json`, '{"previous":"run"}\n');
      fs.writeFileSync(`${base}.trace.jsonl`, 'previous trace');
      const result = spawnSync(process.execPath, ['-e', `
        const cp = require('node:child_process');
        const original = cp.execFileSync;
        cp.execFileSync = (command, args, options) => {
          if (command !== 'claude') return original(command, args, options);
          if (args.includes('--version')) throw new Error('version probe unavailable');
          if (args.includes('--append-system-prompt')) {
            if (!${executionSucceeds}) throw new Error('executor unavailable');
            return [
              JSON.stringify({ type: 'system', subtype: 'init', model: 'test-model' }),
              JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Read fixture' }] } }),
            ].join('\\n');
          }
          return JSON.stringify({
            expectations: [{ id: 1, text: 'The attached project is inspected before reporting a result', passed: true, evidence: 'Read fixture' }],
            summary: { passed: 1, failed: 0, total: 1, pass_rate: 1 }
          });
        };
        require(${JSON.stringify(path.join(root, 'scripts', 'run-evals.js'))}).runBehavioral('alpha-skill', false, ${JSON.stringify(relative)});
      `], { cwd: root, encoding: 'utf8' });
      if (executionSucceeds) {
        assert.equal(result.status, 0, result.stdout + result.stderr);
        const grading = JSON.parse(fs.readFileSync(`${base}.grading.json`, 'utf8'));
        assert.equal(grading.run.claude_cli_version, 'unknown');
        assert.equal(grading.run.executor_model, 'test-model');
        assert.equal(grading.summary.pass_rate, 1);
        assert.doesNotMatch(fs.readFileSync(`${base}.trace.jsonl`, 'utf8'), /previous trace/);
      } else {
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.match(result.stderr, /executor failed; private error details withheld/);
        assert.equal(fs.existsSync(`${base}.grading.json`), false, 'previous grading must not survive the failed new execution');
        assert.equal(fs.existsSync(`${base}.trace.jsonl`), false, 'previous candidate trace must not survive the failed new execution');
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}
