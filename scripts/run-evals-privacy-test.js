#!/usr/bin/env node
'use strict';

// Offline integration tests: every Claude invocation is intercepted before
// the runner loads. The only real subprocesses allowed are local Git setup.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { redactEvidenceText, projectTraceForGrading, persistGradingOutcome, assertGradeableTrace } = require('./lib/eval-evidence');

const PRIVATE_MARKERS = [
  'FICTIONAL_INIT_METADATA', 'FICTIONAL_PRIVATE_PLUGIN', 'FICTIONAL_PRIVATE_MCP',
  'FICTIONAL_PRIVATE_USAGE', 'FICTIONAL_PRIVATE_QUOTA', 'FICTIONAL_PRIVATE_THINKING',
  'FICTIONAL_PRIVATE_UNKNOWN_FIELD', 'FICTIONAL_NON_JSON_PRIVATE_LINE',
  'fictional-user@example.invalid', 'fictional-private-user',
  '00000000-1111-2222-3333-444444444444', 'FICTIONAL_GRADER_PRIVATE_FIELD',
  'fictional-custom-credential',
];
const EXPECTATION = 'The fixture is inspected before reporting a verified result';
const EVIDENCE = 'Fixture evidence: formatDuration(65) returns 1:05';

for (const scenario of ['non-key text', 'JSON key with newline', 'invalid query key',
  'hyphenated text', 'slash-separated text', 'email after a long prefix', 'JSON socket key with newline', 'valid credential field']) {
  test(`redaction completes within a bounded time for a long ${scenario}`, () => {
    // CLI evidence can be megabytes. Repeated keyword fragments without a
    // valid field boundary must not cause quadratic regex backtracking.
    const script = `
      const assert = require('node:assert/strict');
      const { redactEvidenceText } = require('./lib/eval-evidence');
      const scenario = process.argv[1];
      let fragment = 'token';
      if (scenario.includes('hyphen') || scenario.includes('prefix')) fragment = 'token-';
      if (scenario.includes('slash')) fragment = 'token/';
      if (scenario.includes('socket')) fragment = 'socket';
      const field = fragment.repeat(200000);
      let input = field + '!';
      if (scenario.startsWith('JSON')) input = JSON.stringify({ [field + '\\n']: 'fictionalOpaqueCredentialValue', evidence: 'Verified fixture' });
      if (scenario === 'invalid query key') input = 'https://public.example.invalid/file?' + field + '!=public&format=json';
      if (scenario.includes('prefix')) input = field + '! fictional-user@example.invalid';
      if (scenario === 'valid credential field') input = field + '=fictionalOpaqueCredentialValue\\nVerified fixture';
      const output = redactEvidenceText(input);
      if (scenario.startsWith('JSON')) {
        const parsed = JSON.parse(output);
        assert.ok(parsed[field + '\\n'] === '[REDACTED]', 'a private JSON key must not expose its value');
        assert.ok(parsed.evidence === 'Verified fixture');
      } else if (scenario.includes('prefix')) assert.ok(output === field + '! [EMAIL]');
      else if (scenario === 'valid credential field') {
        assert.ok(!output.includes('fictionalOpaqueCredentialValue'));
        assert.ok(output.includes('Verified fixture'));
      } else assert.ok(output === input, 'ordinary text and unrelated query fields must remain');
      process.stdout.write(JSON.stringify({ completed: true }));
    `;
    const result = spawnSync(process.execPath, ['-e', script, scenario], {
      cwd: __dirname, encoding: 'utf8', timeout: 5000, env: { ...process.env, NODE_OPTIONS: '' },
    });
    assert.equal(result.error?.code, undefined, 'redaction must finish instead of timing out');
    assert.equal(result.status, 0, 'the offline redaction process must preserve evidence and privacy');
    assert.deepEqual(JSON.parse(result.stdout), { completed: true });
  });
}

function write(root, relative, content) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function sandbox(t, {
  arm = 'candidate', invalidGrader = false, declaredUnsafe = false, failedStage = null,
  privateExpectation = false, noEvidence = false, publicModelMetadata = false,
  shortMetadata = false, resultOnly = null, resultEvent = null, emptyGitTemplate = false, cliArguments = null,
  hostileGit = null,
  linkedFixture = false, linkedResults = false,
  cleanupFailure = null,
  swapResultsAfterExecutor = false,
  sourceBoundary = null, caseOverrides = {}, evalOverrides = {}, additionalEval = null, fixtureMetadata = null,
  inputStreams = false,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-privacy-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()), 'cleanup must stay in the temporary directory');
    assert.ok(path.basename(root).startsWith('eval-privacy-test-'), 'cleanup must target this test sandbox');
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const relative of ['scripts/run-evals.js', 'scripts/lib/eval-workspace.js', 'scripts/lib/eval-evidence.js', 'scripts/lib/eval-files.js']) {
    write(root, relative, fs.readFileSync(path.join(__dirname, '..', relative)));
  }
  write(root, 'evals/fixtures/project/context.txt', `${EVIDENCE}\n`);
  if (inputStreams) write(root, 'evals/fixtures/project/context.txt:fictional-private-stream', 'FICTIONAL_PRIVATE_STREAM\n');
  if (fixtureMetadata) write(root, `evals/fixtures/project/${fixtureMetadata}`, 'gitdir: fictional-unavailable-repository\n');
  if (linkedFixture) {
    fs.renameSync(path.join(root, 'evals', 'fixtures', 'project'), path.join(root, 'fixture-target'));
    fs.symlinkSync(path.join(root, 'fixture-target'), path.join(root, 'evals', 'fixtures', 'project'),
      process.platform === 'win32' ? 'junction' : 'dir');
  }
  const expectation = shortMetadata ? `${EXPECTATION}; configuration BANKX, INTRA and A.I.` : privateExpectation
    ? `${EXPECTATION}; contact fictional-user@example.invalid; workspace /home/fictional-private-user; api_key=fictional-custom-credential`
    : EXPECTATION;
  write(root, 'evals/cases/alpha-skill.json', JSON.stringify({
    skill_name: 'alpha-skill',
    evals: [{ id: 1, prompt: 'Inspect project/context.txt and report the verified fixture result.',
      expected_output: 'A result grounded in the fixture', files: ['project/context.txt'], expectations: [expectation],
      ...evalOverrides }, ...(additionalEval === null ? [] : [additionalEval])],
    ...caseOverrides,
  }));
  const skill = '---\nname: alpha-skill\ndescription: Inspects an artificial fixture. Use when evaluating this offline test.\n---\n\n# Alpha skill\n\nRead project/context.txt and report its evidence.\n';
  write(root, 'skills/alpha-skill/SKILL.md', skill);
  write(root, 'candidate/SKILL.md', skill);
  if (inputStreams) write(root, 'candidate/SKILL.md:fictional-private-stream', 'FICTIONAL_PRIVATE_STREAM\n');
  write(root, 'candidate/program.json', JSON.stringify({ instruction: 'Artificial canonical fixture only' }));
  write(root, 'candidate/eval-bundle.json', JSON.stringify({ files: [
    'SKILL.md', 'program.json', ...(declaredUnsafe ? ['.env'] : []),
  ] }));
  write(root, 'candidate/.env', 'NOT_A_REAL_SECRET=FICTIONAL_UNLISTED_ENV\n');
  write(root, 'candidate/.hidden.txt', 'FICTIONAL_UNLISTED_HIDDEN\n');
  write(root, 'candidate/untracked-not-in-manifest.txt', 'FICTIONAL_UNLISTED_FILE\n');
  const source = {
    'case directory': 'evals/cases', 'hardlinked case': 'evals/cases/alpha-skill.json',
    'fixture root': 'evals/fixtures', 'skill directory': 'skills/alpha-skill',
    'hardlinked skill': 'skills/alpha-skill/SKILL.md',
  }[sourceBoundary];
  if (source) {
    const sourcePath = path.join(root, source);
    const relocated = path.join(root, 'fictional-external-input');
    fs.renameSync(sourcePath, relocated);
    if (sourceBoundary.startsWith('hardlinked')) fs.linkSync(relocated, sourcePath);
    else fs.symlinkSync(relocated, sourcePath, process.platform === 'win32' ? 'junction' : 'dir');
  }
  const protectedResultFile = path.join(root, 'result-target',
    ...(arm === 'candidate' ? ['skill-dir', 'candidate'] : []), 'alpha-skill.eval-1.grading.json');
  if (linkedResults || swapResultsAfterExecutor) {
    write(root, path.relative(root, protectedResultFile), 'FICTIONAL_EXISTING_UNRELATED_RECORD\n');
  }
  if (linkedResults) {
    fs.symlinkSync(path.join(root, 'result-target'), path.join(root, 'evals', 'results'),
      process.platform === 'win32' ? 'junction' : 'dir');
  }
  // Avoid inheriting a real user's Git configuration, hooks, or templates.
  write(root, 'empty-git-config', '');
  if (hostileGit === 'global config') {
    write(root, 'fictional-global-ignore', '*\n');
    const ignoreFile = path.join(root, 'fictional-global-ignore').replace(/\\/g, '/');
    write(root, 'empty-git-config', `[core]\n\texcludesFile = "${ignoreFile}"\n`);
  }
  if (hostileGit === 'environment') write(root, 'unrelated-project/note.txt', 'FICTIONAL_UNRELATED_PROJECT\n');
  if (emptyGitTemplate) fs.mkdirSync(path.join(root, 'git-template'));
  else write(root, 'git-template/info/exclude', '');
  const childEnv = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR']) {
    if (process.env[key] !== undefined) childEnv[key] = process.env[key];
  }
  Object.assign(childEnv, {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'empty-git-config'),
    GIT_CONFIG_SYSTEM: path.join(root, 'empty-git-config'), GIT_CONFIG_COUNT: '0',
    GIT_TEMPLATE_DIR: path.join(root, 'git-template'), GIT_TERMINAL_PROMPT: '0',
    ANTHROPIC_MODEL: 'fictional-requested-model',
  });
  if (hostileGit === 'environment') Object.assign(childEnv, {
    GIT_DIR: path.join(root, 'unrelated-project', '.git'), GIT_WORK_TREE: path.join(root, 'unrelated-project'),
  });
  const script = `
    const fs = require('node:fs');
    const path = require('node:path');
    const cp = require('node:child_process');
    const realExecFileSync = cp.execFileSync;
    const observation = { versionCalls: 0, executorCalls: 0, graderCalls: 0, forbiddenProcessCalls: 0, processPipeFlags: [], modelEnvironmentSafe: [] };
    observation.cleanupDirectories = [];
    observation.temporaryRoot = require('node:os').tmpdir();
    const realRmSync = fs.rmSync;
    fs.rmSync = (target, options) => {
      const failure = ${JSON.stringify(cleanupFailure)};
      const prefix = failure === 'fixture' ? 'agent-skills-eval-' : 'agent-skills-grader-';
      if (failure && path.basename(target).startsWith(prefix)) {
        observation.cleanupDirectories.push(target);
        throw new Error('FICTIONAL_PRIVATE_UNKNOWN_FIELD fictional-user@example.invalid');
      }
      return realRmSync(target, options);
    };
    process.on('exit', () => fs.writeFileSync('observations.json', JSON.stringify(observation)));
    process.on('uncaughtException', error => {
      observation.uncaughtErrorType = error.name;
      process.exitCode = 99;
    });
    const privateProcessError = () => {
      const error = new Error('FICTIONAL_PRIVATE_UNKNOWN_FIELD fictional-user@example.invalid');
      error.status = 77;
      error.stdout = 'FICTIONAL_PRIVATE_USAGE';
      error.stderr = 'FICTIONAL_PRIVATE_QUOTA /home/fictional-private-user';
      return error;
    };
    cp.execFileSync = (command, args, options = {}) => {
      observation.processPipeFlags.push(Array.isArray(options.stdio) && options.stdio.length === 3 &&
        options.stdio.every(channel => channel === 'pipe'));
      if (command === 'git' && ['init', 'config', 'add', 'commit'].includes(args[0])) {
        if (${JSON.stringify(failedStage)} === 'setup' && args[0] === 'commit') throw privateProcessError();
        return realExecFileSync(command, args, options);
      }
      if (command !== 'claude') {
        observation.forbiddenProcessCalls++;
        throw new Error('An unexpected subprocess was refused by the offline harness');
      }
      observation.modelEnvironmentSafe.push(Boolean(options.env) &&
        !options.env.GIT_DIR && !options.env.GIT_WORK_TREE && options.env.GIT_CONFIG_NOSYSTEM === '1' &&
        options.env.GIT_CONFIG_COUNT === '0' && options.env.ANTHROPIC_MODEL === 'fictional-requested-model');
      if (args.includes('--version')) { observation.versionCalls++; return 'fictional-cli-version\\n'; }
      if (args.includes('stream-json')) {
        observation.executorCalls++;
        observation.executorNoSessionPersistence = args.includes('--no-session-persistence');
        observation.executorPrompt = args[args.indexOf('--append-system-prompt') + 1];
        observation.workspace = options.cwd;
        observation.fixturePresent = fs.existsSync(path.join(options.cwd, 'project', 'context.txt'));
        observation.fixtureStreamPresent = fs.existsSync(path.join(options.cwd, 'project', 'context.txt:fictional-private-stream'));
        const installed = path.join(options.cwd, '.eval-skills', 'alpha-skill');
        observation.installedStreamPresent = fs.existsSync(path.join(installed, 'SKILL.md:fictional-private-stream'));
        observation.installedFiles = ['SKILL.md', 'program.json', '.env', '.hidden.txt', 'untracked-not-in-manifest.txt']
          .filter(name => fs.existsSync(path.join(installed, name)));
        if (${JSON.stringify(failedStage)} === 'executor') throw privateProcessError();
        if (${swapResultsAfterExecutor}) {
          fs.renameSync('evals/results', 'original-results');
          fs.symlinkSync(path.resolve('result-target'), path.resolve('evals/results'),
            process.platform === 'win32' ? 'junction' : 'dir');
        }
        if (${JSON.stringify(resultOnly)} !== null) return JSON.stringify(${JSON.stringify(resultOnly)});
        if (${noEvidence}) return [
          JSON.stringify({ type: 'system', subtype: 'init', private_metadata: 'FICTIONAL_INIT_METADATA',
            session_id: '00000000-1111-2222-3333-444444444444', email: 'fictional-user@example.invalid' }),
          'FICTIONAL_NON_JSON_PRIVATE_LINE',
          JSON.stringify({ type: 'result', usage: { private: 'FICTIONAL_PRIVATE_USAGE' } }),
        ].join('\\n');
        const privateId = '00000000-1111-2222-3333-444444444444';
        const model = ${publicModelMetadata} ? 'fictional-public-model' : 'fictional-model';
        return [
          JSON.stringify({ type: 'system', subtype: 'init', session_id: privateId,
            cwd: 'C:\\\\Users\\\\fictional-private-user\\\\project',
            email: 'fictional-user@example.invalid', model,
            private_metadata: 'FICTIONAL_INIT_METADATA',
            plugins: ${shortMetadata} ? ['BANKX', 'A.I'] : ['FICTIONAL_PRIVATE_PLUGIN'], mcp_servers: ${shortMetadata}
              ? [{ name: 'INTRA', status: 'connected' }] : ${publicModelMetadata}
              ? [{ name: 'FICTIONAL_PRIVATE_MCP', status: 'connected' }] : ['FICTIONAL_PRIVATE_MCP'] }),
          'FICTIONAL_NON_JSON_PRIVATE_LINE',
          JSON.stringify({ type: 'assistant', session_id: privateId, private: 'FICTIONAL_PRIVATE_UNKNOWN_FIELD',
            message: { id: privateId, role: 'assistant', model,
              usage: { marker: 'FICTIONAL_PRIVATE_USAGE' }, content: [
                { type: 'thinking', thinking: 'FICTIONAL_PRIVATE_THINKING' },
                { type: 'text', text: ${shortMetadata}
                  ? 'Loaded bankx, intra and a.i. Database connected; bankxylophone is ordinary fixture text.' : ${publicModelMetadata}
                  ? 'Database connected using fictional-public-model. Server FICTIONAL_PRIVATE_MCP; session ' + privateId
                  : 'I will inspect the artificial fixture.' },
                { type: 'tool_use', id: 'fixture-read', name: 'Read',
                  input: { file_path: path.join(options.cwd, 'project', 'context.txt') },
                  private: 'FICTIONAL_PRIVATE_UNKNOWN_FIELD' },
              ] } }),
          JSON.stringify({ type: 'user', session_id: privateId, message: { role: 'user', content: [
            { type: 'tool_result', tool_use_id: 'fixture-read', content: ${JSON.stringify(EVIDENCE)},
              private: 'FICTIONAL_PRIVATE_UNKNOWN_FIELD' },
          ] } }),
          JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [
            { type: 'text', text: 'The fixture result is verified.' },
          ] } }),
          JSON.stringify({ type: 'result', session_id: privateId, usage: { marker: 'FICTIONAL_PRIVATE_USAGE' },
            ...(${publicModelMetadata} ? { modelUsage: { model: 'fictional-public-model' } } : {}),
            quota: 'FICTIONAL_PRIVATE_QUOTA', private_metadata: 'FICTIONAL_INIT_METADATA',
            ...${JSON.stringify(resultEvent || {})} }),
        ].join('\\n');
      }
      if (args.includes('-p')) {
        observation.graderCalls++;
        observation.graderNoSessionPersistence = args.includes('--no-session-persistence');
        observation.graderInput = options.input;
        observation.graderWorkspace = options.cwd;
        observation.graderDirectoryEmpty = typeof options.cwd === 'string' && fs.readdirSync(options.cwd).length === 0;
        observation.graderToolsDisabled = args.includes('--tools') && args[args.indexOf('--tools') + 1] === '';
        if (${JSON.stringify(failedStage)} === 'grader') throw privateProcessError();
        if (${invalidGrader}) return 'Invalid grader response: FICTIONAL_GRADER_PRIVATE_FIELD fictional-user@example.invalid';
        return JSON.stringify({
          expectations: [{ id: 1, text: ${JSON.stringify(expectation)}, passed: true,
            evidence: ${JSON.stringify(shortMetadata ? `${EVIDENCE}; loaded bankx, intra and a.i.` : EVIDENCE)}, private: 'FICTIONAL_GRADER_PRIVATE_FIELD' }],
          summary: { passed: 1, failed: 0, total: 1, pass_rate: 1, private: 'FICTIONAL_GRADER_PRIVATE_FIELD' },
          private: 'FICTIONAL_GRADER_PRIVATE_FIELD', email: 'fictional-user@example.invalid',
          session_id: '00000000-1111-2222-3333-444444444444',
          run: { private: 'FICTIONAL_GRADER_PRIVATE_FIELD', installed_skill_path: '/home/fictional-private-user' },
        });
      }
      observation.forbiddenProcessCalls++;
      throw new Error('An unexpected mock Claude operation was refused');
    };
    if (${JSON.stringify(cliArguments)} !== null) {
      process.argv = [process.execPath, path.resolve('./scripts/run-evals.js'), ...${JSON.stringify(cliArguments || [])}];
      require('node:module').runMain();
    } else {
      require('./scripts/run-evals.js').runBehavioral('alpha-skill', false, ${arm === 'candidate' ? "'candidate'" : 'null'});
    }
  `;
  const result = spawnSync(process.execPath, ['-e', script], { cwd: root, env: childEnv, encoding: 'utf8' });
  const observedFile = path.join(root, 'observations.json');
  assert.ok(fs.existsSync(observedFile), 'the offline child must record its observations');
  const observed = JSON.parse(fs.readFileSync(observedFile, 'utf8'));
  t.after(() => {
    for (const directory of observed.cleanupDirectories) {
      assert.equal(path.dirname(path.resolve(directory)), path.resolve(observed.temporaryRoot));
      assert.match(path.basename(directory), /^agent-skills-(?:eval|grader)-/);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  assert.equal(observed.forbiddenProcessCalls, 0, 'the runner must not launch any unexpected process');
  const base = path.join(root, 'evals', 'results', ...(arm === 'candidate' ? ['skill-dir', 'candidate'] : []), 'alpha-skill.eval-1');
  return { root, result, observed, base, protectedResultFile };
}

function assertNoPrivateMarkers(value, message) {
  assert.ok(PRIVATE_MARKERS.every(marker => !value.includes(marker)), message);
}

for (const [label, cliArguments] of [
  ['misspelled dry-run', ['--behavioral', 'alpha-skill', '--dryrun']],
  ['extra argument', ['--behavioral', 'alpha-skill', '--skill-dir', 'candidate', 'unexpected-extra']],
  ['duplicate behavioral option', ['--behavioral', 'alpha-skill', '--behavioral', 'alpha-skill']],
  ['duplicate dry-run option', ['--behavioral', 'alpha-skill', '--dry-run', '--dry-run']],
  ['unknown private argument', ['--behavioral', 'alpha-skill', '--FICTIONAL_PRIVATE_UNKNOWN_FIELD']],
]) {
  test(`CLI: rejects ${label} before any model execution`, t => {
    const run = sandbox(t, { arm: 'baseline', cliArguments });
    assert.equal(run.result.status, 1, 'ambiguous or unknown options must fail closed');
    assert.equal(run.observed.executorCalls, 0, 'invalid CLI input must not start the executor');
    assert.equal(run.observed.graderCalls, 0, 'invalid CLI input must not start the grader');
    assert.equal(fs.existsSync(path.join(run.root, 'evals', 'results')), false, 'invalid options must not create result artifacts');
    assertNoPrivateMarkers(run.result.stdout + run.result.stderr, 'CLI errors must not echo private arguments');
  });
}

test('CLI: does not echo a credential-shaped skill identifier in a missing-case diagnostic', t => {
  const privateArgument = 'sk-fictionalcredentialabcdefghijklmnop';
  const run = sandbox(t, { arm: 'baseline', cliArguments: ['--behavioral', privateArgument] });
  assert.equal(run.result.status, 1);
  assert.equal(run.observed.executorCalls, 0);
  assert.ok(!(run.result.stdout + run.result.stderr).includes(privateArgument));
  assert.match(run.result.stderr, /No eval case file/);
});

for (const arm of ['baseline', 'candidate']) {
  test(`${arm}: copies file contents without hidden NTFS streams`, { skip: process.platform !== 'win32' }, t => {
    const run = sandbox(t, { arm, inputStreams: true });
    assert.equal(run.result.status, 0);
    assert.equal(run.observed.fixturePresent, true);
    assert.equal(run.observed.fixtureStreamPresent, false, 'fixture transport must not import undeclared streams');
    assert.equal(run.observed.installedStreamPresent, false, 'candidate transport must not import undeclared streams');
  });
  for (const fixtureMetadata of ['.git/config', 'nested/.Git']) {
    for (const selection of ['project', `project/${fixtureMetadata}`]) {
      test(`${arm}: rejects nested fixture Git metadata ${fixtureMetadata} through ${selection} before version probing`, t => {
        const run = sandbox(t, { arm, fixtureMetadata, evalOverrides: { files: [selection] } });
        assert.equal(run.result.status, 1);
        assert.equal(run.observed.versionCalls, 0, 'nested Git configuration must be refused during input preflight');
        assert.equal(run.observed.executorCalls, 0);
        assert.equal(run.observed.graderCalls, 0);
        assert.equal(fs.existsSync(path.join(run.root, 'evals', 'results')), false);
      });
    }
  }
  for (const withFixtures of [false, true]) {
    test(`${arm}: dialogue ${withFixtures ? 'stages declared fixtures' : 'runs without fixtures'} and installs a candidate only once`, t => {
      const run = sandbox(t, { arm, evalOverrides: { kind: 'dialogue', files: withFixtures ? ['project/context.txt'] : [] } });
      assert.equal(run.result.status, 0);
      assert.equal(run.observed.fixturePresent, withFixtures, 'declared dialogue inputs must be available to the executor');
      assert.ok(run.observed.graderInput.includes('conversation is the artifact'));
      if (arm === 'candidate') assert.deepEqual(run.observed.installedFiles, ['SKILL.md', 'program.json']);
      assert.equal(fs.existsSync(run.observed.workspace), false);
    });
  }
  test(`${arm}: retains workspace ownership and the primary error when setup cleanup fails`, t => {
    const run = sandbox(t, { arm, failedStage: 'setup', cleanupFailure: 'fixture' });
    assert.equal(run.result.status, 1);
    assert.equal(run.observed.executorCalls, 0);
    assert.equal(run.observed.graderCalls, 0);
    const diagnostic = JSON.parse(fs.readFileSync(`${run.base}.grading.error.json`, 'utf8'));
    assert.equal(diagnostic.stage, 'workspace setup');
    assert.equal(diagnostic.exit_status, 77, 'cleanup must not replace the primary setup error');
    assert.equal(diagnostic.cleanup_failed, true, 'the runner must track a workspace before populating it');
    assertNoPrivateMarkers(run.result.stdout + run.result.stderr + JSON.stringify(diagnostic), 'setup diagnostics must not disclose private error details');
  });
  for (const sourceBoundary of ['case directory', 'hardlinked case', 'fixture root',
    ...(arm === 'baseline' ? ['skill directory', 'hardlinked skill'] : [])]) {
    test(`${arm}: rejects linked ${sourceBoundary} before any CLI invocation`, t => {
      const run = sandbox(t, { arm, sourceBoundary });
      assert.equal(run.result.status, 1, 'linked input sources must not be read or transmitted');
      assert.equal(run.observed.versionCalls, 0, 'source validation must precede even version probing');
      assert.equal(run.observed.executorCalls, 0);
      assert.equal(run.observed.graderCalls, 0);
      assertNoPrivateMarkers(run.result.stdout + run.result.stderr, 'source diagnostics must withhold input contents');
    });
  }
  for (const [label, invalidInput] of [
    ['mismatched case identity', { caseOverrides: { skill_name: 'other-skill' } }],
    ['non-array evals', { caseOverrides: { evals: 'FICTIONAL_PRIVATE_UNKNOWN_FIELD' } }],
    ['empty prompt', { evalOverrides: { prompt: ' \n ' } }],
    ['empty expected output', { evalOverrides: { expected_output: '' } }],
    ['blank expectation', { evalOverrides: { expectations: ['   '] } }],
    ['string fixture list', { evalOverrides: { files: 'project/context.txt' } }],
    ['non-string fixture entry', { evalOverrides: { files: [17] } }],
    ['explicit empty kind', { evalOverrides: { kind: '' } }],
    ['provisional execution', { evalOverrides: { trust_level: 'provisional' } }],
    ['invalid later eval', { additionalEval: { id: 2, kind: 'unknown', prompt: 'Another fixture prompt',
      expected_output: 'A verified fixture result', files: ['project/context.txt'], expectations: [EXPECTATION] } }],
  ]) {
    test(`${arm}: preflights ${label} before any CLI invocation or result mutation`, t => {
      const run = sandbox(t, { arm, ...invalidInput });
      assert.equal(run.result.status, 1);
      assert.equal(run.observed.versionCalls, 0, 'all evaluations must be validated before probing');
      assert.equal(run.observed.executorCalls, 0, 'a valid earlier eval must not run before an invalid later eval is rejected');
      assert.equal(run.observed.graderCalls, 0);
      assert.equal(fs.existsSync(path.join(run.root, 'evals', 'results')), false);
      assertNoPrivateMarkers(run.result.stdout + run.result.stderr, 'schema diagnostics must not echo invalid private values');
    });
  }
  test(`${arm}: rechecks a replaced results directory before grading`, t => {
    const run = sandbox(t, { arm, swapResultsAfterExecutor: true });
    assert.equal(run.result.status, 1);
    assert.equal(run.observed.executorCalls, 1);
    assert.equal(run.observed.graderCalls, 0, 'an unsafe result destination must stop before the second model call');
    assert.equal(fs.readFileSync(run.protectedResultFile, 'utf8'), 'FICTIONAL_EXISTING_UNRELATED_RECORD\n');
  });

  test(`${arm}: preserves the primary failure when workspace cleanup also fails`, t => {
    const run = sandbox(t, { arm, failedStage: 'executor', cleanupFailure: 'fixture' });
    assert.equal(run.result.status, 1);
    const error = JSON.parse(fs.readFileSync(`${run.base}.grading.error.json`, 'utf8'));
    assert.equal(error.error, 'evaluation_failed');
    assert.equal(error.stage, 'executor');
    assert.equal(error.exit_status, 77);
    assert.equal(error.cleanup_failed, true);
    assertNoPrivateMarkers(JSON.stringify(error), 'combined failures must retain only safe diagnostic fields');
  });

  for (const cleanupFailure of ['fixture', 'grader']) {
    test(`${arm}: reports ${cleanupFailure} cleanup failure instead of exiting successfully`, t => {
      const run = sandbox(t, { arm, cleanupFailure });
      assert.equal(run.result.status, 1, 'unremoved evaluation data must not be reported as a successful run');
      const error = JSON.parse(fs.readFileSync(`${run.base}.grading.error.json`, 'utf8'));
      assert.equal(error.error, 'cleanup_failed');
      assertNoPrivateMarkers(run.result.stdout + run.result.stderr + JSON.stringify(error), 'cleanup diagnostics must contain no private error or directory');
      assert.ok(run.observed.cleanupDirectories.length > 0, 'the injected cleanup fault must actually be exercised');
    });
  }

  test(`${arm}: rejects fixture ancestor links before model execution`, t => {
    const run = sandbox(t, { arm, linkedFixture: true });
    assert.equal(run.result.status, 1, 'a fixture must not resolve through a directory link');
    assert.equal(run.observed.executorCalls, 0);
    assert.equal(run.observed.graderCalls, 0);
  });

  test(`${arm}: rejects linked results directories without replacing another record`, t => {
    const run = sandbox(t, { arm, linkedResults: true });
    assert.equal(run.result.status, 1, 'results must remain in their intended repository directory');
    assert.equal(run.observed.executorCalls, 0);
    assert.equal(run.observed.graderCalls, 0);
    assert.equal(fs.readFileSync(run.protectedResultFile, 'utf8'), 'FICTIONAL_EXISTING_UNRELATED_RECORD\n');
  });

  test(`${arm}: isolates all CLI environments from host Git redirection while preserving the requested model`, t => {
    const run = sandbox(t, { arm, hostileGit: 'environment' });
    assert.equal(run.result.status, 0);
    assert.equal(run.observed.modelEnvironmentSafe.length, 3, 'version, executor and grader must all be covered');
    assert.ok(run.observed.modelEnvironmentSafe.every(Boolean), 'every CLI process must receive the isolated environment');
  });

  for (const hostileGit of ['global config', 'environment']) {
    test(`${arm}: fixture Git initialization ignores inherited ${hostileGit}`, t => {
      const run = sandbox(t, { arm, hostileGit });
      assert.equal(run.result.status, 0, 'only the fresh fixture repository may control its Git setup');
      assert.equal(run.observed.executorCalls, 1);
      if (hostileGit === 'environment') {
        assert.equal(fs.existsSync(path.join(run.root, 'unrelated-project', '.git')), false,
          'inherited GIT_DIR must not create metadata in another project');
        assert.equal(fs.readFileSync(path.join(run.root, 'unrelated-project', 'note.txt'), 'utf8'),
          'FICTIONAL_UNRELATED_PROJECT\n');
      }
    });
  }

  test(`${arm}: removes short private metadata and case variants at every grading sink`, t => {
    const run = sandbox(t, { arm, shortMetadata: true });
    assert.equal(run.result.status, 0, 'the offline stub evaluation must complete');
    const saved = fs.readFileSync(`${run.base}.grading.json`, 'utf8');
    const outputs = [run.observed.graderInput, saved];
    if (arm === 'candidate') outputs.push(fs.readFileSync(`${run.base}.trace.jsonl`, 'utf8'));
    for (const output of outputs) {
      assert.doesNotMatch(output, /\b(?:bankx|intra|a\.i)\b/i, 'known private configuration names must be removed');
    }
    assert.ok(run.observed.graderInput.includes('bankxylophone'), 'a short private name must not erase longer unrelated words');
    assert.ok(run.observed.graderInput.includes('Database connected'), 'connection status is public evidence');
    assert.ok(saved.includes(EVIDENCE), 'the grading evidence must survive redaction');
  });

  for (const [label, resultOnly] of [
    ['empty success', { type: 'result', result: ' \n ', is_error: false, subtype: 'success' }],
    ['empty error', { type: 'result', result: '', is_error: true, subtype: 'error_max_turns' }],
    ['error text', { type: 'result', result: 'FICTIONAL_PRIVATE_UNKNOWN_FIELD', is_error: true }],
    ['error subtype', { type: 'result', result: EVIDENCE, subtype: 'error_max_turns' }],
    ['malformed error state', { type: 'result', result: EVIDENCE, is_error: 'false' }],
  ]) {
    test(`${arm}: refuses ${label} output before invoking a grader`, t => {
      const run = sandbox(t, { arm, resultOnly });
      assert.equal(run.result.status, 1, 'missing evidence or execution failure must fail the run');
      assert.equal(run.observed.graderCalls, 0, 'unusable execution output must not trigger a model grading call');
      assert.equal(fs.existsSync(`${run.base}.grading.json`), false, 'unusable execution must not produce successful grading');
      assertNoPrivateMarkers(fs.readFileSync(`${run.base}.grading.error.json`, 'utf8'), 'diagnostics must contain no executor content');
    });
  }

  test(`${arm}: rejects a reported execution failure even when partial evidence exists`, t => {
    const run = sandbox(t, { arm, resultEvent: { result: 'Partial fixture output', is_error: true, subtype: 'error_max_turns' } });
    assert.equal(run.result.status, 1);
    assert.equal(run.observed.graderCalls, 0, 'partial evidence must not override the executor failure');
    assert.equal(fs.existsSync(`${run.base}.grading.json`), false);
  });

  test(`${arm}: strips init, identifiers, plugins, MCP, home paths and telemetry before grading`, t => {
    const run = sandbox(t, { arm });
    assert.equal(run.result.status, 0, 'the offline stub evaluation must complete');
    assert.equal(run.observed.executorCalls, 1, 'one stub executor call is expected');
    assert.equal(run.observed.graderCalls, 1, 'one stub grader call is expected');
    assertNoPrivateMarkers(run.observed.graderInput, 'private executor metadata must not reach the grader');
    assert.ok(!run.observed.graderInput.includes(run.observed.workspace), 'absolute workspace paths must not reach the grader');
  });

  test(`${arm}: preserves observable tool call and result evidence for grading`, t => {
    const run = sandbox(t, { arm });
    assert.equal(run.result.status, 0, 'the offline stub evaluation must complete');
    assert.ok(run.observed.graderInput.includes('Read'), 'the tool name must remain available as evidence');
    const normalizedInput = run.observed.graderInput.replace(/\\+/g, '/');
    assert.ok(normalizedInput.includes('project/context.txt'), 'the tool input must retain its recognizable fixture path');
    assert.ok(run.observed.graderInput.includes(EVIDENCE), 'the tool result must remain available as evidence');
    assert.ok(run.observed.graderInput.includes('The fixture result is verified.'), 'assistant output must remain gradeable');
  });

  test(`${arm}: keeps installed prompt paths and saved run paths relative`, t => {
    const run = sandbox(t, { arm });
    assert.equal(run.result.status, 0, 'the offline stub evaluation must complete');
    assert.ok(!run.observed.executorPrompt.includes(run.root), 'the executor prompt must not expose the checkout path');
    assert.ok(!run.observed.executorPrompt.includes(run.observed.workspace), 'the executor prompt must not expose the temporary path');
    const grading = JSON.parse(fs.readFileSync(`${run.base}.grading.json`, 'utf8'));
    const expectedSkillPath = arm === 'candidate'
      ? '.eval-skills/alpha-skill/SKILL.md' : 'skills/alpha-skill/SKILL.md';
    assert.ok(grading.run.installed_skill_path === expectedSkillPath,
      'saved run metadata must identify the exact relative skill path');
  });

  test(`${arm}: runs the grader without tools in a fresh empty directory`, t => {
    const run = sandbox(t, { arm });
    assert.equal(run.result.status, 0, 'the offline stub evaluation must complete');
    assert.ok(run.observed.graderToolsDisabled, 'the grader must be launched with tools explicitly disabled');
    assert.ok(run.observed.graderDirectoryEmpty, 'the grader must not inherit project files or instructions');
    assert.notEqual(run.observed.graderWorkspace, run.observed.workspace, 'the grader must not reuse the executor workspace');
    assert.notEqual(run.observed.graderWorkspace, run.root, 'the grader must not use the source checkout');
  });

  test(`${arm}: requests no CLI session persistence for executor and grader`, t => {
    const run = sandbox(t, { arm });
    assert.equal(run.result.status, 0, 'the offline stub evaluation must complete');
    assert.ok(run.observed.executorNoSessionPersistence && run.observed.graderNoSessionPersistence,
      'both model invocations must request no local CLI session persistence');
  });

  test(`${arm}: captures every subprocess stream without implicit stderr output`, t => {
    const run = sandbox(t, { arm });
    assert.equal(run.result.status, 0, 'the offline stub evaluation must complete');
    assert.ok(run.observed.processPipeFlags.length > 0 && run.observed.processPipeFlags.every(Boolean),
      'every Claude and Git subprocess must explicitly pipe all three streams');
  });

  test(`${arm}: drops unknown fields from otherwise valid grader output`, t => {
    const run = sandbox(t, { arm });
    assert.equal(run.result.status, 0, 'the offline stub evaluation must complete');
    const saved = fs.readFileSync(`${run.base}.grading.json`, 'utf8');
    assertNoPrivateMarkers(saved, 'unknown grader fields must not be persisted');
    assert.ok(saved.includes(EVIDENCE), 'accepted grading evidence must remain available');
  });

  test(`${arm}: redacts privacy values in expectation text before grading`, t => {
    const run = sandbox(t, { arm, privateExpectation: true });
    assert.equal(run.result.status, 0, 'the offline stub evaluation must complete');
    assertNoPrivateMarkers(run.observed.graderInput, 'expectation text must be redacted before reaching the grader');
    assert.ok(run.observed.graderInput.includes(EXPECTATION), 'the expectation meaning must remain available');
    assertNoPrivateMarkers(fs.readFileSync(`${run.base}.grading.json`, 'utf8'), 'saved expectation text must remain redacted');
  });

  test(`${arm}: never saves invalid grader raw content`, t => {
    const run = sandbox(t, { arm, invalidGrader: true });
    assert.equal(run.result.status, 1, 'invalid grading must fail the offline evaluation');
    assert.equal(fs.existsSync(`${run.base}.grading.raw.txt`), false, 'unknown invalid grader content must not be saved');
    assert.equal(fs.existsSync(`${run.base}.grading.json`), false, 'invalid grading must not look successful');
    const diagnostic = `${run.base}.grading.error.json`;
    assert.ok(fs.existsSync(diagnostic), 'a static error diagnostic must explain the failure');
    assertNoPrivateMarkers(fs.readFileSync(diagnostic, 'utf8'), 'error diagnostics must not contain raw grader content');
  });

  test(`${arm}: does not start a grader when the trace contains no gradeable evidence`, t => {
    const run = sandbox(t, { arm, noEvidence: true });
    assert.equal(run.result.status, 1, 'a trace with no gradeable evidence must fail');
    assert.equal(run.observed.executorCalls, 1, 'the executor was stubbed once');
    assert.equal(run.observed.graderCalls, 0, 'private metadata alone must not trigger a grader invocation');
    assert.equal(fs.existsSync(`${run.base}.grading.json`), false, 'missing evidence must not produce successful grading');
  });

  for (const failedStage of ['executor', 'grader']) {
    test(`${arm}: keeps ${failedStage} process error contents out of diagnostics`, t => {
      const run = sandbox(t, { arm, failedStage });
      assert.equal(run.result.status, 1, 'a failed process must fail the evaluation without an uncaught exception');
      assertNoPrivateMarkers(run.result.stdout + run.result.stderr, 'console diagnostics must not echo process error contents');
      const results = path.dirname(run.base);
      const files = fs.existsSync(results) ? fs.readdirSync(results) : [];
      assert.ok(files.some(file => file.endsWith('.error.json')), 'a static process error diagnostic must be written');
      for (const file of files) {
        const artifact = fs.readFileSync(path.join(results, file), 'utf8');
        assertNoPrivateMarkers(artifact, 'saved process diagnostics must not echo message, stdout, or stderr');
      }
      assert.equal(fs.existsSync(`${run.base}.grading.json`), false, 'a process failure must not leave successful grading');
    });
  }
}

test('candidate: persists only a sanitized evidence trace', t => {
  const run = sandbox(t);
  assert.equal(run.result.status, 0, 'the offline stub evaluation must complete');
  const trace = fs.readFileSync(`${run.base}.trace.jsonl`, 'utf8');
  assertNoPrivateMarkers(trace, 'saved traces must omit private metadata and thinking');
  assert.ok(!trace.includes(run.observed.workspace), 'saved traces must omit absolute workspace paths');
  assert.ok(trace.includes('Read') && trace.includes(EVIDENCE), 'saved traces must retain the useful tool evidence');
});

test('candidate: copies only declared files and ignores unrelated sensitive files', t => {
  const run = sandbox(t);
  assert.equal(run.result.status, 0, 'the offline stub evaluation must complete');
  assert.ok(run.observed.installedFiles.includes('SKILL.md') && run.observed.installedFiles.includes('program.json'),
    'declared skill files must be installed');
  assert.ok(['.env', '.hidden.txt', 'untracked-not-in-manifest.txt'].every(name => !run.observed.installedFiles.includes(name)),
    'undeclared environment, hidden and unrelated files must not be copied');
});

test('candidate: installs with an existing empty Git template directory', t => {
  const run = sandbox(t, { emptyGitTemplate: true });
  assert.equal(run.result.status, 0, 'Git template contents must not be required for candidate installation');
  assert.equal(run.observed.executorCalls, 1);
  assert.equal(run.observed.graderCalls, 1);
  assert.ok(fs.existsSync(`${run.base}.grading.json`));
});

test('candidate: rejects a credential file even when it is declared', t => {
  const run = sandbox(t, { declaredUnsafe: true });
  assert.equal(run.result.status, 1, 'a declared credential file must be refused');
  assert.equal(run.observed.executorCalls, 0, 'invalid bundles must be rejected before executor invocation');
  assert.equal(run.observed.graderCalls, 0, 'invalid bundles must be rejected before grader invocation');
});

test('keeps public model identity and ordinary connected text while dropping private MCP metadata', t => {
  const run = sandbox(t, { publicModelMetadata: true });
  assert.equal(run.result.status, 0, 'the offline stub evaluation must complete');
  assert.ok(run.observed.graderInput.includes('Database connected'), 'public status enums must not erase ordinary evidence text');
  assert.ok(run.observed.graderInput.includes('fictional-public-model'), 'public model names must not be collected as private identifiers');
  assertNoPrivateMarkers(run.observed.graderInput, 'private MCP names and transport identifiers must still be removed');
  const grading = JSON.parse(fs.readFileSync(`${run.base}.grading.json`, 'utf8'));
  assert.ok(grading.run.executor_model === 'fictional-public-model', 'saved run metadata must retain its nonprivate executor model');
});

const FICTIONAL_CONTEXT = {
  workspace: 'C:\\offline\\fixture-workspace', repositoryRoot: 'C:\\offline\\fixture-repository',
  homeDirectory: 'C:\\Users\\fictional-private-user', username: 'fictional-private-user',
};

for (const username of ['xy', '测试用户']) {
  for (const sink of ['plain text', 'projected tool result', 'saved grader evidence']) {
    test(`${sink}: redacts a known ${username === 'xy' ? 'short' : 'non-Latin'} username without corrupting longer words`, t => {
      const context = { ...FICTIONAL_CONTEXT, username };
      const text = `Owner ${username}; unrelated ${username}extended; ${EVIDENCE}`;
      const output = sink === 'projected tool result' ? projectTraceForGrading(toolEvidence(text), context)
        : sink === 'saved grader evidence' ? savedEvidence(t, text, context) : redactEvidenceText(text, context);
      assert.ok(!output.includes(`Owner ${username};`), 'known user identities must not depend on ASCII word boundaries or a minimum length');
      assert.ok(output.includes(`${username}extended`), 'unrelated longer words must survive');
      assert.ok(output.includes(EVIDENCE));
    });
  }
}

for (const field of ['username', 'user_name', 'userName']) {
  test(`removes a ${field} identity echoed from initialization metadata`, () => {
    const raw = [
      { type: 'system', subtype: 'init', [field]: 'FictionalKnownIdentity' },
      { type: 'assistant', message: { content: [{ type: 'text', text: `Owner FictionalKnownIdentity; ${EVIDENCE}` }] } },
    ].map(event => JSON.stringify(event)).join('\n');
    const output = projectTraceForGrading(raw, FICTIONAL_CONTEXT);
    assert.ok(!output.includes('FictionalKnownIdentity'));
    assert.ok(output.includes(EVIDENCE));
  });
}

test('preserves public origin and original text while removing organization identity fields', () => {
  const output = JSON.parse(redactEvidenceText(JSON.stringify({
    origin: 'https://public.example.invalid', originalText: EVIDENCE,
    organizationName: 'FICTIONAL_PRIVATE_ORGANIZATION', org_id: 'fictional-org-identifier',
  }), FICTIONAL_CONTEXT));
  assert.equal(output.origin, 'https://public.example.invalid');
  assert.equal(output.originalText, EVIDENCE);
  assert.equal(output.organizationName, '[REDACTED]');
  assert.equal(output.org_id, '[REDACTED]');
});

test('keeps a safe boolean failure marker without retaining result transport metadata', () => {
  const projected = projectTraceForGrading(JSON.stringify({
    type: 'result', result: '', is_error: true, subtype: 'error_max_turns',
    private_metadata: 'FICTIONAL_PRIVATE_UNKNOWN_FIELD',
  }), FICTIONAL_CONTEXT);
  assert.deepEqual(JSON.parse(projected), { type: 'result', result: '', is_error: true });
  assert.throws(() => assertGradeableTrace(projected), /Executor reported failure/);
});

test('accepts successful final text without requiring duplicate assistant text', () => {
  const projected = projectTraceForGrading(JSON.stringify({
    type: 'result', result: EVIDENCE, is_error: false, subtype: 'success',
  }), FICTIONAL_CONTEXT);
  assert.doesNotThrow(() => assertGradeableTrace(projected));
  assert.ok(projected.includes(EVIDENCE));
});

test('rejects whitespace assistant turns and empty orphan tool results', () => {
  const raw = [
    { type: 'assistant', message: { content: [{ type: 'text', text: '\n  ' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'empty-call', content: '' }] } },
  ].map(event => JSON.stringify(event)).join('\n');
  assert.throws(() => assertGradeableTrace(projectTraceForGrading(raw, FICTIONAL_CONTEXT)), /No supported evidence/);
});

function toolEvidence(content) {
  return [
    { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'fictional-read-call', name: 'Read', input: { file_path: 'project/context.txt' } },
    ] } },
    { type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'fictional-read-call', content },
    ] } },
  ].map(event => JSON.stringify(event)).join('\n');
}

function savedEvidence(t, evidence, context = FICTIONAL_CONTEXT) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-privacy-grade-test-'));
  t.after(() => {
    assert.ok(path.dirname(path.resolve(root)) === path.resolve(os.tmpdir()) &&
      path.basename(root).startsWith('eval-privacy-grade-test-'), 'cleanup must stay in this test sandbox');
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = path.join(root, 'grade');
  persistGradingOutcome(base, {
    expectations: [{ id: 1, text: EXPECTATION, passed: true, evidence }],
    summary: { passed: 1, failed: 0, total: 1, pass_rate: 1 },
  }, null, context);
  return fs.readFileSync(`${base}.grading.json`, 'utf8');
}

for (const field of ['token', 'client_secret', 'Cookie', 'api_token', 'db_password',
  'OPENAI_API_KEY', 'AZURE_OPENAI_API_KEY', 'service-api-key-value', 'X-Amz-Credential', 'X-Goog-Signature',
  'access_key', 'AZURE_ACCESS_KEY', 'service.api_key']) {
  const privateValue = 'fictionalOpaqueCredentialValue';
  for (const sink of ['plain text', 'JSON tool text', 'projected tool result', 'saved grader evidence']) {
    test(`${sink}: redacts custom credential field ${field}`, t => {
      const text = sink === 'plain text'
        ? `${field}='${privateValue}'\n${EVIDENCE}`
        : JSON.stringify({ [field]: privateValue, evidence: EVIDENCE });
      const output = sink === 'projected tool result' ? projectTraceForGrading(toolEvidence(text), FICTIONAL_CONTEXT)
        : sink === 'saved grader evidence' ? savedEvidence(t, text)
          : redactEvidenceText(text, FICTIONAL_CONTEXT);
      assert.ok(!output.includes(privateValue), 'credential values must be removed at this evidence sink');
      assert.ok(output.includes(EVIDENCE), 'useful verification evidence must remain');
    });
  }
}

for (const [label, url] of [
  ['AWS signature', 'https://public.example.invalid/file?X-Amz-Credential=fictionalOpaqueCredentialValue&X-Amz-Signature=fictionalOpaqueCredentialValue&format=json'],
  ['SAS signature', 'https://public.example.invalid/file?sig=fictionalOpaqueCredentialValue&format=json'],
  ['encoded key', 'https://public.example.invalid/file?%61pi_key=fictionalOpaqueCredentialValue&format=json'],
  ['dotted key', 'https://public.example.invalid/file?service.api_key=fictionalOpaqueCredentialValue&format=json'],
  ['quoted key', 'https://public.example.invalid/file?api_key="fictionalOpaqueCredentialValue"&format=json'],
  ['unterminated quoted key', 'https://public.example.invalid/file?api_key="fictionalOpaqueCredentialValue'],
  ['malformed encoded public key', 'https://public.example.invalid/file?%zz=public&token=fictionalOpaqueCredentialValue&format=json'],
]) {
  for (const sink of ['plain text', 'projected tool result', 'saved grader evidence']) {
    test(`${sink}: redacts ${label} query values while preserving unrelated URL fields`, t => {
      const text = `${url}\n${EVIDENCE}`;
      const output = sink === 'projected tool result' ? projectTraceForGrading(toolEvidence(text), FICTIONAL_CONTEXT)
        : sink === 'saved grader evidence' ? savedEvidence(t, text) : redactEvidenceText(text, FICTIONAL_CONTEXT);
      assert.ok(!output.includes('fictionalOpaqueCredentialValue'));
      if (url.includes('format=json')) assert.ok(output.includes('format=json'));
      assert.ok(output.includes(EVIDENCE));
    });
  }
}
for (const [label, header] of [
  ...['Token', 'ApiKey', 'Digest'].map(scheme => [scheme, `'Authorization: ${scheme} ${scheme === 'Digest'
    ? 'username="fictional-owner", response="fictionalOpaqueCredentialValue"' : 'fictionalOpaqueCredentialValue'}'`]),
  ['Cookie', "'Cookie: harmless=fixture; session=fictionalOpaqueCredentialValue'"],
  ['Proxy', "'Proxy-Authorization: Token fictionalOpaqueCredentialValue'"],
  ['escaped Digest', '"Authorization: Digest username=\\"fixture\\", response=\\"fictionalOpaqueCredentialValue\\""'],
]) {
  for (const sink of ['plain text', 'projected tool result', 'saved grader evidence']) {
    test(`${sink}: redacts a quoted ${label} private header without dropping the command URL`, t => {
      const text = `curl -H ${header} https://public.example.invalid/file\n${EVIDENCE}`;
      const output = sink === 'projected tool result' ? projectTraceForGrading(toolEvidence(text), FICTIONAL_CONTEXT)
        : sink === 'saved grader evidence' ? savedEvidence(t, text) : redactEvidenceText(text, FICTIONAL_CONTEXT);
      assert.ok(!output.includes('fictionalOpaqueCredentialValue'));
      assert.ok(output.includes('https://public.example.invalid/file'));
      assert.ok(output.includes(EVIDENCE));
    });
  }
}
test('query email redaction preserves the public URL authority', () => {
  const output = redactEvidenceText('https://public.example.invalid?contact=fictional-user@example.invalid&format=json', FICTIONAL_CONTEXT);
  assert.ok(output.startsWith('https://public.example.invalid?contact='));
  assert.ok(output.includes('format=json'));
  assert.ok(!output.includes('fictional-user@example.invalid'));
});
test('fragment email redaction preserves the public URL authority', () => {
  const output = redactEvidenceText('https://public.example.invalid#contact=fictional-user@example.invalid', FICTIONAL_CONTEXT);
  assert.equal(output, 'https://public.example.invalid#contact=[EMAIL]');
});
for (const sink of ['plain text', 'projected tool result', 'saved grader evidence']) {
  test(`${sink}: removes every email from a URL path, multiple query values, and fragment`, t => {
    const text = 'https://public.example.invalid/team/fictional-one@example.invalid?primary=fictional-two@example.invalid&secondary=fictional-three@example.invalid#contact=fictional-four@example.invalid';
    const output = sink === 'projected tool result' ? projectTraceForGrading(toolEvidence(text), FICTIONAL_CONTEXT)
      : sink === 'saved grader evidence' ? savedEvidence(t, text) : redactEvidenceText(text, FICTIONAL_CONTEXT);
    assert.ok(output.includes('https://public.example.invalid/team/[EMAIL]?primary=[EMAIL]&secondary=[EMAIL]#contact=[EMAIL]'));
    assert.ok(!/fictional-(?:one|two|three|four)@/.test(output));
  });
}
test('ordinary email redaction covers valid punctuation in the local part', () => {
  assert.equal(redactEvidenceText('Email: fictional/user=name?alias&tag@example.invalid', FICTIONAL_CONTEXT), 'Email: [EMAIL]');
});

for (const encoded of ['fictional-user%40example.invalid', '%66%69%63%74%69%6f%6e%61%6c%2d%75%73%65%72%40%65%78%61%6d%70%6c%65%2e%69%6e%76%61%6c%69%64', 'fictional-user%40example.invalid%FF']) {
  for (const sink of ['plain text', 'projected tool result', 'saved grader evidence']) {
    test(`${sink}: removes a ${encoded.endsWith('%FF') ? 'malformed UTF-8 encoded' : encoded.startsWith('%') ? 'fully encoded' : 'percent-at encoded'} email from every URL component`, t => {
      const text = `https://public.example.invalid/team/${encoded}?primary=${encoded}&format=json#contact=${encoded}\n${EVIDENCE}`;
      const output = sink === 'projected tool result' ? projectTraceForGrading(toolEvidence(text), FICTIONAL_CONTEXT)
        : sink === 'saved grader evidence' ? savedEvidence(t, text) : redactEvidenceText(text, FICTIONAL_CONTEXT);
      assert.ok(!output.includes(encoded), 'encoded email addresses must not bypass any evidence sink');
      assert.ok(output.includes('https://public.example.invalid/team/[EMAIL]?primary=[EMAIL]&format=json#contact=[EMAIL]'));
      assert.ok(output.includes(EVIDENCE));
    });
  }
}

test('encoded public URL fields remain unchanged when they contain no email', () => {
  const url = 'https://public.example.invalid/path%20name?format=json&label=ordinary%20public%20text#section%201';
  assert.equal(redactEvidenceText(url, FICTIONAL_CONTEXT), url);
});

test('an encoded email in a URL field name is not retained as a public label', () => {
  const output = redactEvidenceText('https://public.example.invalid?fictional-user%40example.invalid=public&format=json', FICTIONAL_CONTEXT);
  assert.equal(output, 'https://public.example.invalid?[EMAIL]&format=json');
});
for (const [label, value] of [
  ['escaped quotes', 'fixture\\"fictionalOpaqueCredentialValue'],
  ['multiple lines', 'fixture\nfictionalOpaqueCredentialValue'],
]) {
  for (const sink of ['plain text', 'projected tool result', 'saved grader evidence']) {
    test(`${sink}: removes the whole quoted credential containing ${label}`, t => {
      const text = `config API_KEY="${value}"\n${EVIDENCE}`;
      const output = sink === 'projected tool result' ? projectTraceForGrading(toolEvidence(text), FICTIONAL_CONTEXT)
        : sink === 'saved grader evidence' ? savedEvidence(t, text) : redactEvidenceText(text, FICTIONAL_CONTEXT);
      assert.ok(!output.includes('fictionalOpaqueCredentialValue'));
      assert.ok(output.includes(EVIDENCE));
    });
  }
}
for (const [label, text] of [
  ['header', 'curl -H "Authorization: Token fictionalOpaqueCredentialValue'],
  ['field', 'config API_KEY="fictionalOpaqueCredentialValue'],
]) {
  for (const sink of ['plain text', 'projected tool result', 'saved grader evidence']) {
    test(`${sink}: fails closed on an unterminated quoted private ${label}`, t => {
      const input = `${text}\n${EVIDENCE}`;
      const output = sink === 'projected tool result' ? projectTraceForGrading(toolEvidence(input), FICTIONAL_CONTEXT)
        : sink === 'saved grader evidence' ? savedEvidence(t, input) : redactEvidenceText(input, FICTIONAL_CONTEXT);
      assert.ok(!output.includes('fictionalOpaqueCredentialValue'));
      assert.ok(output.includes(EVIDENCE));
    });
  }
}

for (const prefix of ['    ', '  12→ ']) {
  test(`redacts directory-listing owner and group with ${prefix.trim() ? 'Read line-number' : 'indent'} prefix`, () => {
    const listing = `${prefix}-rw-r--r-- 1 fictional-listing-owner fictional-listing-group 17 Oct 11 10:00 context.txt`;
    const output = redactEvidenceText(listing, FICTIONAL_CONTEXT);
    assert.ok(!output.includes('fictional-listing-owner') && !output.includes('fictional-listing-group'),
      'owner and group identities must be removed even when the listing is prefixed');
    assert.ok(output.includes('context.txt'), 'the listed file must remain available as evidence');
  });
}

for (const extended of [false, true]) {
  test(`redacts ${extended ? 'extended ' : ''}UNC paths in evidence`, () => {
    const unc = extended
      ? '\\\\?\\UNC\\fictional-private-server\\share\\fictional-owner\\notes.txt'
      : '\\\\fictional-private-server\\share\\fictional-owner\\notes.txt';
    const output = redactEvidenceText(`Read '${unc}'.\n${EVIDENCE}`, FICTIONAL_CONTEXT);
    assert.ok(!output.includes('fictional-private-server') && !output.includes('fictional-owner'),
      'private UNC server and owner names must not remain');
    assert.ok(output.includes(EVIDENCE), 'the unrelated verification result must remain');
  });
}

test('redacts known Windows directory prefixes with either slash convention', () => {
  const prefixes = [FICTIONAL_CONTEXT.workspace, FICTIONAL_CONTEXT.repositoryRoot, FICTIONAL_CONTEXT.homeDirectory];
  const text = prefixes.flatMap(prefix => [prefix, prefix.replace(/\\/g, '/')])
    .map(prefix => `Path: '${prefix}/project/context.txt'`).join('\n');
  const output = redactEvidenceText(text, FICTIONAL_CONTEXT);
  assert.ok(prefixes.every(prefix => !output.includes(prefix) && !output.includes(prefix.replace(/\\/g, '/'))),
    'known directory prefixes must be removed in both slash variants');
  assert.ok(output.includes('<EVAL_WORKSPACE>') && output.includes('<REPOSITORY>') && output.includes('[PRIVATE_HOME]'),
    'the path role must remain identifiable without its absolute prefix');
  assert.ok(output.includes('project/context.txt'), 'relative file evidence must remain');
});

test('redacts email and UUID when a tool result is quoted as grader evidence', t => {
  const text = `${EVIDENCE}; contact fictional-user@example.invalid; reference 00000000-1111-2222-3333-444444444444`;
  const outputs = [redactEvidenceText(text, FICTIONAL_CONTEXT),
    projectTraceForGrading(toolEvidence(text), FICTIONAL_CONTEXT), savedEvidence(t, text)];
  for (const output of outputs) {
    assertNoPrivateMarkers(output, 'quoted tool results must not restore private email or identifiers');
    assert.ok(output.includes(EVIDENCE), 'useful tool evidence must remain');
  }
});

test('projects only supported evidence blocks and discards nested extras and image data', () => {
  const marker = 'FICTIONAL_UNKNOWN_BLOCK_OR_EXTRA';
  const trace = [
    { type: 'assistant', private: marker, message: { role: 'assistant', id: marker, private: marker, content: [
      { type: 'thinking', thinking: marker, signature: marker },
      { type: 'image', source: { type: 'base64', data: marker } },
      { type: 'unknown', content: marker },
      { type: 'text', text: EVIDENCE, signature: marker, private: marker },
      { type: 'tool_use', id: 'fictional-read', name: 'Read', private: marker,
        input: { file_path: 'project/context.txt', private: marker, authorization: marker } },
    ] } },
    { type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'fictional-read', private: marker, content: [
        { type: 'text', text: EVIDENCE, private: marker },
        { type: 'image', source: { type: 'base64', data: marker } },
        { type: 'unknown', content: marker },
      ] },
    ] } },
  ].map(event => JSON.stringify(event)).join('\n');
  const output = projectTraceForGrading(trace, FICTIONAL_CONTEXT);
  assert.ok(!output.includes(marker), 'unknown fields, thinking, signature and image contents must be omitted');
  assert.ok(output.includes('Read') && output.includes('project/context.txt') && output.includes(EVIDENCE),
    'the supported tool and text evidence must survive projection');
});

test('keeps anonymous tool identifiers correlated across reversed results', () => {
  const originalIds = ['toolu_FICTIONAL_IDENTIFIER_ONE', 'toolu_FICTIONAL_IDENTIFIER_TWO'];
  const trace = [
    { type: 'assistant', message: { role: 'assistant', content: originalIds.map((id, index) =>
      ({ type: 'tool_use', id, name: 'Read', input: { file_path: `project/file-${index}.txt` } })) } },
    { type: 'user', message: { role: 'user', content: [...originalIds].reverse().map((id, index) =>
      ({ type: 'tool_result', tool_use_id: id, content: `Fixture result ${index}` })) } },
  ].map(event => JSON.stringify(event)).join('\n');
  const projected = projectTraceForGrading(trace, FICTIONAL_CONTEXT);
  assert.ok(originalIds.every(id => !projected.includes(id)), 'original transport identifiers must not survive');
  const events = projected.split('\n').map(line => JSON.parse(line));
  const calls = events[0].message.content;
  const results = events[1].message.content;
  assert.ok(calls.every(call => /^call_\d+$/.test(call.id)), 'tool IDs must be replaced with local anonymous IDs');
  assert.equal(results[0].tool_use_id, calls[1].id, 'the first reversed result must identify the second call');
  assert.equal(results[1].tool_use_id, calls[0].id, 'the second reversed result must identify the first call');
  assert.notEqual(calls[0].id, calls[1].id, 'distinct calls must not collapse to one identifier');
});

test('preserves a native Skill handoff so a grader can detect premature planning', () => {
  const trace = [
    { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'fictional-skill-call', name: 'Skill', input: {
        skill: 'planning-and-task-breakdown', args: 'fixture-safe-args fictional-user@example.invalid',
      } },
    ] } },
    { type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'fictional-skill-call', content: 'Handoff invoked before any fixture approval.' },
    ] } },
  ].map(event => JSON.stringify(event)).join('\n');
  const projected = projectTraceForGrading(trace, FICTIONAL_CONTEXT);
  const events = projected.split('\n').map(line => JSON.parse(line));
  const handoff = events[0].message.content.find(block => block.type === 'tool_use');
  assert.ok(handoff.name === 'Skill' && handoff.input.skill === 'planning-and-task-breakdown',
    'projection must retain the actual Skill invocation and named handoff');
  assert.ok(handoff.input.args.includes('fixture-safe-args'), 'safe handoff arguments must remain gradeable');
  assertNoPrivateMarkers(projected, 'handoff argument privacy values must remain redacted');
});
