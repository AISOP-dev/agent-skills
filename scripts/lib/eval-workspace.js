'use strict';

// Fixture materialization and confined, manifest-listed candidate bundles.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { assertNoLinkedAncestors } = require('./eval-files');
const ROOT = path.join(__dirname, '..', '..');
const FIXTURES_DIR = path.join(ROOT, 'evals', 'fixtures');
// Git for Windows accepts the DOS device name, not Node's Win32 device path.
const GIT_NULL = process.platform === 'win32' ? 'NUL' : os.devNull;

function evaluationEnvironment() {
  const environment = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  Object.assign(environment, {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: GIT_NULL,
    GIT_CONFIG_SYSTEM: GIT_NULL, GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0',
  });
  return environment;
}

// Skill name must be a valid kebab-case identifier — no path separators,
// no "..", no absolute paths. Without this, --behavioral "../../x" would
// resolve to files outside the project tree for both reads and writes.
const VALID_SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function portablePathComponent(component) {
  if (component === '.' || component === '..') return true;
  return !/[<>:"|?*\\/\u0000-\u001f]/.test(component) && !/[. ]$/.test(component) &&
    !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:[. ]|$)/i.test(component);
}

function resolveFixturePath(root, rel) {
  if (typeof rel !== 'string' || !rel.trim() || path.isAbsolute(rel) || path.win32.isAbsolute(rel) ||
      rel.split(/[\\/]/).some(component => component && !portablePathComponent(component))) {
    throw new Error('Fixture path must be a portable relative path without device aliases or streams');
  }
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, rel.replace(/\\/g, '/'));
  const back = path.relative(resolvedRoot, resolvedPath);
  if (back === '' || back === '..' || back.startsWith(`..${path.sep}`) || path.isAbsolute(back)) {
    throw new Error('Fixture path escapes workspace');
  }
  return resolvedPath;
}

// Experimental bundles must be regular files inside the checkout. Reject
// symlinks (including directory junctions) rather than copying external data.
function checkBundleFiles(directory, { fixture = false } = {}) {
  if (fixture && path.basename(directory).toLowerCase() === '.git') {
    throw new Error('Fixture input tree contains reserved Git metadata');
  }
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink()) throw new Error('Evaluation input tree contains a symlink');
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(directory)) {
      if (fixture && !portablePathComponent(entry)) throw new Error('Fixture input tree contains a nonportable filename');
      checkBundleFiles(path.join(directory, entry), { fixture });
    }
  } else if (!stat.isFile()) {
    throw new Error('Evaluation input tree contains a non-regular file');
  } else if (stat.nlink > 1) {
    throw new Error('Evaluation input tree contains a hardlinked file');
  }
}

function copyFileContents(source, destination) {
  const stat = fs.lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error('Evaluation input must be a regular, unlinked file');
  // CopyFileW (used by Node's copyFile/cp on Windows) also copies hidden NTFS
  // streams. Transfer only the default stream, with bounded memory, so input
  // metadata cannot silently bypass the fixture selection or bundle manifest.
  const input = fs.openSync(source, 'r');
  let output;
  try {
    output = fs.openSync(destination, 'w', stat.mode & 0o777);
    const buffer = Buffer.alloc(64 * 1024);
    let count;
    while ((count = fs.readSync(input, buffer, 0, buffer.length, null)) > 0) {
      let written = 0;
      while (written < count) {
        const next = fs.writeSync(output, buffer, written, count - written, null);
        if (!next) throw new Error('Evaluation input copy could not complete');
        written += next;
      }
    }
  } finally {
    try { if (output !== undefined) fs.closeSync(output); }
    finally { fs.closeSync(input); }
  }
}

function copyFixtureTree(source, destination) {
  const stat = fs.lstatSync(source);
  if (path.basename(source).toLowerCase() === '.git') throw new Error('Fixture input tree contains reserved Git metadata');
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source)) {
      if (!portablePathComponent(entry)) throw new Error('Fixture input tree contains a nonportable filename');
      copyFixtureTree(path.join(source, entry), path.join(destination, entry));
    }
  } else {
    copyFileContents(source, destination);
  }
}

const BUNDLE_TEXT_EXTENSIONS = new Set(['.md', '.json', '.txt', '.yaml', '.yml', '.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx', '.py', '.sh']);

function readBundleManifest(directory) {
  const manifestFile = path.join(directory, 'eval-bundle.json');
  let manifest;
  try {
    if (fs.statSync(manifestFile).size > 64 * 1024) throw new Error();
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8').replace(/^\uFEFF/, ''));
  } catch { throw new Error('skill bundle requires a valid eval-bundle.json manifest'); }
  if (!manifest || Object.keys(manifest).length !== 1 || !Array.isArray(manifest.files) ||
      !manifest.files.length || !manifest.files.includes('SKILL.md')) {
    throw new Error('eval-bundle.json must contain only files[], including SKILL.md');
  }
  const seen = new Set();
  for (const file of manifest.files) {
    const parts = typeof file === 'string' ? file.split('/') : [];
    if (!parts.length || parts.some((part) => !/^[a-z0-9][a-z0-9._-]*$/i.test(part) || !portablePathComponent(part) ||
        /^(?:credentials?|secrets?|tokens?|passwords?|id_rsa|id_ed25519)(?:[._-]|$)/i.test(part)) ||
        !BUNDLE_TEXT_EXTENSIONS.has(path.extname(file).toLowerCase()) ||
        file === 'eval-bundle.json' || seen.has(file.toLowerCase())) {
      throw new Error('eval-bundle.json contains a duplicate, unsafe, or sensitive file entry');
    }
    seen.add(file.toLowerCase());
    let current = directory;
    for (const [index, part] of parts.entries()) {
      current = path.join(current, part);
      let stat;
      try { stat = fs.lstatSync(current); }
      catch { throw new Error('eval-bundle.json lists a missing file, including required SKILL.md'); }
      if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
        throw new Error('eval-bundle.json must list regular files without symlink ancestors');
      }
    }
  }
  return [...manifest.files];
}

function loadSkillBundle(skillName, relativeDirectory) {
  if (!VALID_SKILL_NAME.test(skillName)) throw new Error('Invalid skill name for --skill-dir');
  if (typeof relativeDirectory !== 'string' || !relativeDirectory ||
      path.isAbsolute(relativeDirectory) || path.win32.isAbsolute(relativeDirectory) ||
      relativeDirectory.split(/[\\/]/).includes('..')) {
    throw new Error('--skill-dir must be a repo-relative directory without traversal');
  }
  const directory = resolveFixturePath(ROOT, relativeDirectory);
  const relative = path.relative(path.resolve(ROOT), directory);
  let ancestor = path.resolve(ROOT);
  for (const component of relative.split(path.sep)) {
    ancestor = path.join(ancestor, component);
    let stat;
    try { stat = fs.lstatSync(ancestor); }
    catch { throw new Error('--skill-dir directory does not exist'); }
    if (stat.isSymbolicLink()) throw new Error('--skill-dir crosses a symlink');
  }
  const realRoot = fs.realpathSync(ROOT);
  const realDirectory = fs.realpathSync(directory);
  const back = path.relative(realRoot, realDirectory);
  if (back === '..' || back.startsWith(`..${path.sep}`) || path.isAbsolute(back)) {
    throw new Error('--skill-dir escapes the repository');
  }
  if (!fs.statSync(directory).isDirectory()) throw new Error('--skill-dir must select a directory');
  checkBundleFiles(directory);
  const files = readBundleManifest(directory);
  const file = path.join(directory, 'SKILL.md');
  let content;
  try { content = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); }
  catch { throw new Error('skill bundle requires SKILL.md'); }
  const frontmatter = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  const rawName = frontmatter && (frontmatter[1].match(/^name:\s*(.+)$/m) || [])[1];
  const name = rawName && rawName.trim().replace(/^(['"])(.*)\1$/, '$2');
  if (name !== skillName) throw new Error(`SKILL.md frontmatter name must match ${skillName}`);
  return { name: skillName, directory, relativeDirectory: relative.split(path.sep).join('/'), files };
}

function copySkillBundle(bundle, workspace) {
  const reserved = path.join(workspace, '.eval-skills');
  if (fs.existsSync(reserved) || fs.readdirSync(workspace).includes('.eval-skills')) {
    throw new Error('fixture data conflicts with reserved .eval-skills directory');
  }
  // Recheck just before copying, including after fixture working-tree patches.
  const checked = loadSkillBundle(bundle.name, bundle.relativeDirectory);
  const installed = path.join(reserved, bundle.name);
  fs.mkdirSync(reserved);
  for (const file of checked.files) {
    const destination = path.join(installed, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    copyFileContents(path.join(checked.directory, file), destination);
  }
  return path.join(installed, 'SKILL.md');
}

function skillSystemPrompt(skillFile, workspace) {
  const relative = path.relative(workspace, skillFile).split(path.sep).join('/');
  if (relative.startsWith('../') || path.isAbsolute(relative)) throw new Error('installed skill must be inside the workspace');
  return `Follow this skill exactly:\n\nSkill file: ${relative}\nSkill directory: ${path.posix.dirname(relative)}\nResolve this skill's supporting files from that directory, relative to your working directory.\n\n${fs.readFileSync(skillFile, 'utf8')}`;
}

function materializeWorkspace(ev, bundle = null) {
  // Fresh throwaway project dir per eval; fixtures (if any) copied in so the
  // agent has real code to operate on rather than describing what it would do.
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-skills-eval-'));
  try {
    return initializeWorkspace(ev, workspace, bundle);
  } catch (error) {
    fs.rmSync(workspace, { recursive: true, force: true });
    throw error;
  }
}

function validateFixtureInputs(ev) {
  const inputs = [];
  for (const rel of ev.files || []) {
    const src = resolveFixturePath(FIXTURES_DIR, rel);
    if (path.relative(FIXTURES_DIR, src).split(path.sep).some(component => component.toLowerCase() === '.git')) {
      throw new Error('Fixture conflicts with reserved .git metadata');
    }
    // The checkout is the trust anchor: fixtures/ itself must not be a link.
    assertNoLinkedAncestors(ROOT, src, { allowMissing: true });
    if (!fs.existsSync(src)) {
      throw new Error(`fixture listed in files[] not found: evals/fixtures/${rel}`);
    }
    checkBundleFiles(src, { fixture: true });
    inputs.push({ relative: rel, source: src });
  }
  return inputs;
}

// The caller owns this directory before population starts, including failures.
function initializeWorkspace(ev, workspace, bundle = null) {
  const setupDirs = new Set();
  for (const { relative, source } of validateFixtureInputs(ev)) {
    const dest = resolveFixturePath(workspace, relative);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    copyFixtureTree(source, dest);
    const fixtureRoot = fs.statSync(dest).isDirectory() ? dest : path.dirname(dest);
    setupDirs.add(path.join(fixtureRoot, '.eval'));
  }
  const workingTreePatches = [];
  for (const setupDir of setupDirs) {
    const patchFile = path.join(setupDir, 'working-tree.patch');
    if (fs.existsSync(patchFile)) workingTreePatches.push(fs.readFileSync(patchFile, 'utf8'));
    if (fs.existsSync(setupDir)) fs.rmSync(setupDir, { recursive: true, force: true });
  }
  // Give workflow-oriented evals a real baseline to inspect, modify, diff, and
  // commit. A local identity keeps this deterministic and never leaves the
  // throwaway workspace.
  // Fixture Git operations must not read personal config or inherit a target
  // repository, alternate index, template, signer, or hooks from the host.
  const gitOptions = { cwd: workspace, env: evaluationEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] };
  execFileSync('git', ['init', '--quiet', '--template='], gitOptions);
  execFileSync('git', ['config', 'core.hooksPath', GIT_NULL], gitOptions);
  execFileSync('git', ['config', 'core.autocrlf', 'false'], gitOptions);
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], gitOptions);
  execFileSync('git', ['config', 'user.name', 'Skill Eval'], gitOptions);
  execFileSync('git', ['config', 'user.email', 'skill-eval@example.invalid'], gitOptions);
  execFileSync('git', ['add', '--all'], gitOptions);
  // Empty directories and entirely ignored fixtures still need a baseline.
  execFileSync('git', ['commit', '--quiet', '--allow-empty', '-m', 'fixture baseline'], gitOptions);
  for (const workingTreePatch of workingTreePatches) {
    // Parse mode changes with Git itself. A symlink patch may become a plain
    // file on Windows, so rejecting only realized filesystem links is too late
    // to enforce the same fixture boundary on every platform.
    const summary = execFileSync('git', ['apply', '--summary', '-'], {
      ...gitOptions, input: workingTreePatch, encoding: 'utf8',
    });
    if (/^ (?:create mode 120000 |mode change \d+ => 120000 )/m.test(summary)) {
      throw new Error('Fixture working-tree patch introduces a symbolic link');
    }
    execFileSync('git', ['apply', '--whitespace=nowarn', '-'], {
      ...gitOptions,
      input: workingTreePatch,
      encoding: 'utf8',
    });
  }
  // The original inputs were checked before copying; patches form another
  // input boundary. Recheck their realized tree before installing instructions
  // or allowing an executor to inspect it. Only our own root .git is exempt.
  for (const entry of fs.readdirSync(workspace)) {
    if (entry === '.git') continue;
    if (!portablePathComponent(entry)) throw new Error('Fixture working tree contains a nonportable filename');
    checkBundleFiles(path.join(workspace, entry), { fixture: true });
  }
  if (bundle) {
    copySkillBundle(bundle, workspace);
    // Keep installed instructions separate from the project change evidence.
    fs.mkdirSync(path.join(workspace, '.git', 'info'), { recursive: true });
    fs.appendFileSync(path.join(workspace, '.git', 'info', 'exclude'), '\n/.eval-skills/\n');
  }
  return workspace;
}

module.exports = { VALID_SKILL_NAME, resolveFixturePath, validateFixtureInputs, loadSkillBundle, copySkillBundle, skillSystemPrompt, materializeWorkspace, initializeWorkspace, evaluationEnvironment };
