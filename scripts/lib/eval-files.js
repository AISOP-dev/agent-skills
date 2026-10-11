'use strict';

// Filesystem boundaries for local inputs, results, and generated artifacts.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function assertNoLinkedAncestors(root, target, { allowMissing = false } = {}) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Evaluation path escapes its trusted root');
  }
  let current = path.resolve(root);
  const parts = relative ? relative.split(path.sep) : [];
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (allowMissing && error.code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error('Evaluation path crosses a symlink or junction');
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error('Evaluation path has a non-directory ancestor');
  }
}

function ensureEvalDirectory(root, directory, { create = true } = {}) {
  assertNoLinkedAncestors(root, directory, { allowMissing: true });
  if (create) fs.mkdirSync(directory, { recursive: true });
  if (fs.existsSync(directory)) {
    assertNoLinkedAncestors(root, directory);
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unsafe evaluation directory');
  }
}

function assertEvalFile(file, root = path.dirname(file)) {
  assertNoLinkedAncestors(root, file, { allowMissing: true });
  const parent = fs.lstatSync(path.dirname(file));
  if (parent.isSymbolicLink() || !parent.isDirectory()) throw new Error('Unsafe evaluation file directory');
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) throw new Error('Unsafe or linked evaluation file');
}

function writeEvalArtifact(file, content, root = path.dirname(file)) {
  assertEvalFile(file, root);
  const temporary = path.join(path.dirname(file), `.eval-result-${randomUUID()}.tmp`);
  // A failed exclusive open grants no ownership of an existing collision.
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    try { fs.writeFileSync(descriptor, content); }
    finally { fs.closeSync(descriptor); }
    // Replace an owned result atomically; interrupted writes never publish a
    // partial grading file. Rename also avoids writing through a swapped link.
    assertEvalFile(file, root);
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

module.exports = { assertNoLinkedAncestors, ensureEvalDirectory, assertEvalFile, writeEvalArtifact };
