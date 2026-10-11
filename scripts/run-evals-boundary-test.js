#!/usr/bin/env node
'use strict';

// Offline path and routing regressions. CLI children run deterministic checks
// or --dry-run only; these tests never invoke a model CLI.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { resolveFixturePath, evaluationEnvironment } = require('./lib/eval-workspace');

const RUNTIME_FILES = ['run-evals.js', 'lib/eval-workspace.js', 'lib/eval-evidence.js', 'lib/eval-files.js'];
const SKILL = '---\nname: alpha-skill\ndescription: Handles alpha widgets. Use when changing alpha widgets.\n---\n\n# Alpha\n';
function evalCase(name = 'alpha-skill', keyword = 'alpha') {
  return {
    skill_name: name,
    trigger: { positive: [1, 2, 3].map(() => ({ prompt: `change ${keyword} widgets`, top_k: 1 })),
      negative: [{ prompt: 'unrelated banana request' }, { prompt: 'unrelated orange request' }] },
    evals: [{ id: 1, prompt: 'Inspect the artificial fixture.', expected_output: 'A verified fixture result',
      files: ['project/context.txt'], expectations: ['The fixture is inspected'] }],
  };
}
function write(root, file, content) {
  const destination = path.join(root, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content);
}
function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-boundary-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('eval-boundary-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const file of RUNTIME_FILES) write(root, `scripts/${file}`, fs.readFileSync(path.join(__dirname, file)));
  write(root, 'skills/alpha-skill/SKILL.md', SKILL);
  write(root, 'evals/fixtures/project/context.txt', 'Artificial fixture only\n');
  write(root, 'evals/cases/alpha-skill.json', JSON.stringify(evalCase()));
  return root;
}
function run(root, args = []) {
  return spawnSync(process.execPath, [path.join(root, 'scripts/run-evals.js'), ...args], {
    cwd: root, encoding: 'utf8', env: { ...evaluationEnvironment(), NODE_OPTIONS: '' },
  });
}

for (const ignored of [false, true]) {
  test(`a ${ignored ? 'fully ignored' : 'empty'} fixture still has a usable Git baseline`, t => {
    const root = sandbox(t);
    if (ignored) write(root, 'evals/fixtures/project/.gitignore', '*\n');
    else fs.unlinkSync(path.join(root, 'evals/fixtures/project/context.txt'));
    const runner = require(path.join(root, 'scripts/run-evals.js'));
    const workspace = runner.materializeWorkspace({ files: ['project'] });
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const result = spawnSync('git', ['rev-list', '--count', 'HEAD'], {
      cwd: workspace, encoding: 'utf8', env: evaluationEnvironment(),
    });
    assert.equal(result.status, 0, 'an empty tracked tree must still have one baseline commit');
    assert.equal(result.stdout.trim(), '1');
    if (ignored) assert.equal(fs.readFileSync(path.join(workspace, 'project/context.txt'), 'utf8'), 'Artificial fixture only\n');
  });
}

test('fixture working-tree patches cannot introduce symbolic links', t => {
  const root = sandbox(t);
  const target = path.join(root, 'fictional-private-context');
  fs.writeFileSync(target, 'FICTIONAL_UNRELATED_RECORD\n');
  const link = target.replace(/\\/g, '/');
  write(root, 'evals/fixtures/project/.eval/working-tree.patch',
    `diff --git a/project/linked-context b/project/linked-context\nnew file mode 120000\n--- /dev/null\n+++ b/project/linked-context\n@@ -0,0 +1 @@\n+${link}\n\\ No newline at end of file\n`);
  const runner = require(path.join(root, 'scripts/run-evals.js'));
  let workspace;
  try {
    assert.throws(() => { workspace = runner.materializeWorkspace({ files: ['project'] }); }, /link/i,
      'regular patch input must not bypass the fixture link boundary');
    assert.equal(fs.readFileSync(target, 'utf8'), 'FICTIONAL_UNRELATED_RECORD\n');
  } finally { if (workspace) fs.rmSync(workspace, { recursive: true, force: true }); }
});

test('fixture working-tree patch output must still have portable filenames', t => {
  const root = sandbox(t);
  write(root, 'evals/fixtures/project/.eval/working-tree.patch',
    'diff --git a/project/name?.txt b/project/name?.txt\nnew file mode 100644\n--- /dev/null\n+++ b/project/name?.txt\n@@ -0,0 +1 @@\n+Artificial fixture only\n');
  const runner = require(path.join(root, 'scripts/run-evals.js'));
  let workspace;
  try {
    assert.throws(() => { workspace = runner.materializeWorkspace({ files: ['project'] }); },
      /nonportable|invalid path|Invalid argument/i,
      'Git accepting a patch does not establish portable fixture filenames');
  } finally { if (workspace) fs.rmSync(workspace, { recursive: true, force: true }); }
});

for (const selector of ['C:project/context.txt', 'C:/project/context.txt', 'C:\\project\\context.txt',
  '\\server\\share\\context.txt', '\\\\server\\share\\context.txt', '/project/context.txt',
  'project/context.txt:private-stream', 'project/.git.', 'project/.git ', 'project/CON.md',
  'project/aux.json', 'project/NUL.txt', 'project/com1.md', 'project/LPT9.txt',
  'project/COM¹.txt', 'project/name?.txt', 'project/context' + String.fromCharCode(0) + '.txt']) {
  test(`fixture selectors reject a nonportable or device path: ${JSON.stringify(selector)}`, () => {
    assert.throws(() => resolveFixturePath(path.resolve('fictional-fixture-root'), selector),
      /relative|portable|reserved|unsafe/i);
  });
}
for (const selector of [undefined, null, 17, [], {}]) {
  test(`fixture selectors reject a non-string value ${JSON.stringify(selector)}`, () => {
    assert.throws(() => resolveFixturePath(path.resolve('fictional-fixture-root'), selector), /relative|portable|invalid/i);
  });
}
test('fixture selectors use either slash convention without depending on the host OS', () => {
  const root = path.resolve('fictional-fixture-root');
  assert.equal(resolveFixturePath(root, 'project\\nested\\context.txt'), path.join(root, 'project', 'nested', 'context.txt'));
  assert.equal(resolveFixturePath(root, 'project/nested/context.txt'), path.join(root, 'project', 'nested', 'context.txt'));
  assert.throws(() => resolveFixturePath(root, 'project\\..\\..\\outside.txt'), /escape|relative|unsafe/);
});
test('fixture selectors retain ordinary spaces and normalized confined paths', () => {
  const root = path.resolve('fictional-fixture-root');
  assert.equal(resolveFixturePath(root, './folder/../project/sample file.txt'), path.join(root, 'project', 'sample file.txt'));
});

for (const length of [0, 64 * 1024, 64 * 1024 + 13]) {
  test(`fixture copying preserves ${length} bytes of binary input`, t => {
    const root = sandbox(t);
    const input = Buffer.alloc(length);
    for (let index = 0; index < length; index++) input[index] = index % 256;
    write(root, 'evals/fixtures/project/context.txt', input);
    const runner = require(path.join(root, 'scripts/run-evals.js'));
    const workspace = runner.materializeWorkspace({ files: ['project'] });
    t.after(() => {
      assert.equal(path.dirname(path.resolve(workspace)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(workspace).startsWith('agent-skills-eval-'));
      fs.rmSync(workspace, { recursive: true, force: true });
    });
    assert.deepEqual(fs.readFileSync(path.join(workspace, 'project/context.txt')), input);
  });
}
test('fixture copying retries partial writes and preserves executable mode where supported', t => {
  const root = sandbox(t);
  const input = Buffer.alloc(64 * 1024 + 17, 0xab);
  const source = path.join(root, 'evals/fixtures/project/context.txt');
  write(root, 'evals/fixtures/project/context.txt', input);
  if (process.platform !== 'win32') fs.chmodSync(source, 0o755);
  const runner = require(path.join(root, 'scripts/run-evals.js'));
  const originalWrite = fs.writeSync;
  let partialWrites = 0;
  let workspace;
  try {
    fs.writeSync = function(fd, buffer, offset, length, position) {
      if (Buffer.isBuffer(buffer) && length > 4096) {
        partialWrites++;
        return originalWrite.call(this, fd, buffer, offset, 4096, position);
      }
      return originalWrite.apply(this, arguments);
    };
    workspace = runner.materializeWorkspace({ files: ['project'] });
  } finally {
    fs.writeSync = originalWrite;
    if (workspace) t.after(() => {
      assert.equal(path.dirname(path.resolve(workspace)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(workspace).startsWith('agent-skills-eval-'));
      fs.rmSync(workspace, { recursive: true, force: true });
    });
  }
  assert.ok(partialWrites > 0, 'the partial-write condition must be exercised');
  const destination = path.join(workspace, 'project/context.txt');
  assert.deepEqual(fs.readFileSync(destination), input);
  if (process.platform !== 'win32') assert.ok(fs.statSync(destination).mode & 0o100);
});
for (const fault of ['zero progress', 'write error']) {
  test(`fixture copying cleans its workspace after ${fault}`, t => {
    const root = sandbox(t);
    write(root, 'evals/fixtures/project/context.txt', Buffer.alloc(64 * 1024, 0xab));
    const runner = require(path.join(root, 'scripts/run-evals.js'));
    const originalWrite = fs.writeSync;
    const originalTemporary = fs.mkdtempSync;
    let workspace;
    try {
      fs.mkdtempSync = function(prefix, ...args) {
        const directory = originalTemporary.call(this, prefix, ...args);
        if (path.basename(directory).startsWith('agent-skills-eval-')) workspace = directory;
        return directory;
      };
      fs.writeSync = function(fd, buffer, offset, length, position) {
        if (Buffer.isBuffer(buffer) && length === 64 * 1024) {
          if (fault === 'zero progress') return 0;
          throw new Error('Artificial write fault');
        }
        return originalWrite.apply(this, arguments);
      };
      assert.throws(() => runner.materializeWorkspace({ files: ['project'] }), /copy could not complete|Artificial write fault/);
    } finally {
      fs.writeSync = originalWrite;
      fs.mkdtempSync = originalTemporary;
    }
    assert.ok(workspace, 'the injected fault must occur after workspace creation');
    assert.equal(path.dirname(path.resolve(workspace)), path.resolve(os.tmpdir()));
    assert.equal(fs.existsSync(workspace), false, 'a failed file copy must leave no temporary fixture data');
  });
}

test('the skill catalog ignores ordinary files alongside skill directories', t => {
  const root = sandbox(t);
  write(root, 'skills/README.md', 'Artificial catalog note\n');
  const result = run(root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
for (const [label, skill] of [
  ['BOM and CRLF', '\uFEFF' + SKILL.replace(/\n/g, '\r\n')],
  ['quoted name', SKILL.replace('name: alpha-skill', 'name: "alpha-skill"')],
]) {
  test(`baseline routing accepts frontmatter with ${label}`, t => {
    const root = sandbox(t);
    write(root, 'skills/alpha-skill/SKILL.md', skill);
    const result = run(root);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}
test('case JSON accepts an editor-added UTF-8 BOM in deterministic and dry-run modes', t => {
  const root = sandbox(t);
  write(root, 'evals/cases/alpha-skill.json', '\uFEFF' + JSON.stringify(evalCase()));
  for (const args of [[], ['--behavioral', 'alpha-skill', '--dry-run']]) {
    const result = run(root, args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
});
test('candidate manifests accept an editor-added UTF-8 BOM', t => {
  const root = sandbox(t);
  write(root, 'candidate/SKILL.md', SKILL);
  write(root, 'candidate/eval-bundle.json', '\uFEFF' + JSON.stringify({ files: ['SKILL.md'] }));
  const result = run(root, ['--behavioral', 'alpha-skill', '--skill-dir', 'candidate', '--dry-run']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

for (const topK of [null, 0, -1, 1.5, '3', true, {}, [], Number.MAX_SAFE_INTEGER + 1]) {
  test(`trigger schema rejects invalid top_k ${JSON.stringify(topK)}`, t => {
    const root = sandbox(t); const data = evalCase();
    data.trigger.positive[0].top_k = topK;
    write(root, 'evals/cases/alpha-skill.json', JSON.stringify(data));
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /schema/);
  });
}
for (const owner of [null, '', false, 0, {}, []]) {
  test(`trigger schema rejects an explicitly invalid owner ${JSON.stringify(owner)}`, t => {
    const root = sandbox(t); const data = evalCase();
    data.trigger.negative[0].owner = owner;
    write(root, 'evals/cases/alpha-skill.json', JSON.stringify(data));
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /schema/);
  });
}
test('a negative owner must outscore the tested skill instead of winning a sort-order tie', t => {
  const root = sandbox(t);
  write(root, 'skills/beta-skill/SKILL.md', SKILL.replaceAll('alpha', 'beta'));
  const beta = evalCase('beta-skill', 'beta');
  beta.trigger.negative[0] = { prompt: 'widgets', owner: 'alpha-skill' };
  write(root, 'evals/cases/beta-skill.json', JSON.stringify(beta));
  const result = run(root);
  assert.equal(result.status, 1, 'an equal nonzero score is not proof of a routing owner');
  assert.match(result.stdout, /does not outrank/);
});

for (const file of ['CON.md', 'notes./guide.md', 'aux/data.json', 'README.md.']) {
  test(`candidate manifest rejects nonportable filename ${file} before a missing-file check`, t => {
    const root = sandbox(t);
    write(root, 'candidate/SKILL.md', SKILL);
    write(root, 'candidate/eval-bundle.json', JSON.stringify({ files: ['SKILL.md', file] }));
    const result = run(root, ['--behavioral', 'alpha-skill', '--skill-dir', 'candidate', '--dry-run']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unsafe|portable|reserved|sensitive/i);
    assert.equal(fs.existsSync(path.join(root, 'evals/results')), false);
  });
}
