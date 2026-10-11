#!/usr/bin/env node
"use strict";

// Local issue #309 pilot checks, not an AISP conformance validator or executor.
const fs = require("node:fs");
const path = require("node:path");
const { assertEvalFile, writeEvalArtifact } = require("../../scripts/lib/eval-files");
const { redactEvidenceText } = require("../../scripts/lib/eval-evidence");
const ROOT = path.resolve(__dirname, "..", "..");
const ID = "spec_driven_development_aisp";
const DEFAULT_DIR = path.join(__dirname, "aisp", ID);
const POLICIES = [
  ["review_spec", "plan"], ["review_plan", "tasks"], ["review_tasks", "implement"],
  ["review_map", "prepare_module"], ["review_result", "next_module"], ["review_result", "end"],
];
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = value => typeof value === "string" && value.trim().length > 0;
const strings = value => Array.isArray(value) && value.length > 0 && value.every(text);
const normalize = value => value.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
function call(step) {
  if (typeof step !== "string") return null;
  const match = step.trim().match(/^(sys\.[\w.]+)\((.*)\)(?:\s*->\s*(\w+))?$/);
  return match && { name: match[1], args: match[2], store: match[3] };
}
function reachable(graph, entry, removed) {
  const visited = new Set(); const pending = Array.isArray(entry) ? [...entry] : [entry];
  while (pending.length) {
    const node = pending.pop();
    if (node === removed || visited.has(node) || !graph.has(node)) continue;
    visited.add(node); pending.push(...graph.get(node));
  }
  return visited;
}
function approvalBinding(node, body, step) {
  const next = `step${Number(step.slice(4)) + 1}`;
  if (typeof body[step] !== "string" || typeof body[next] !== "string") return null;
  const confirm = body[step]?.trim().match(/^sys\.io\.confirm\((['"])(.*?)\1,\s*options=\[\s*(['"])approve\3,\s*(['"])reject\4,\s*(['"])modify\5\s*\]\)\s*->\s*(\w+)$/);
  const assertion = body[next]?.trim().match(/^sys\.assert\((['"])(.*?)\1,\s*(['"])(.*?)\3\)$/);
  if (!confirm || !assertion || !assertion[4].trim()) return null;
  const comparison = assertion[2].trim().match(/^(\w+)\s*==\s*(['"])approve\2$/);
  return comparison && comparison[1] === confirm[6] ? `${node}.${next}:sys.assert` : null;
}
function validateProgram(program) {
  const errors = [];
  const fail = message => errors.push(message);
  if (!Array.isArray(program) || program.length !== 2 || program[0]?.role !== "system" || program[1]?.role !== "user")
    return ["Expected exactly two messages with system and user roles."];
  const system = program[0].content; const content = program[1].content;
  if (!object(system) || !object(content)) return ["Message content must be objects."];
  for (const key of ["protocol", "axiom_0", "id", "name", "version", "license", "summary", "description", "flow_format", "loading_mode"])
    if (!text(system[key])) fail(`Missing string metadata: ${key}.`);
  for (const [key, expected] of Object.entries({ protocol: "AISP V1.0.0", axiom_0: "Human_Sovereignty_and_Wellbeing", id: ID, flow_format: "jsonflow", loading_mode: "node" }))
    if (system[key] !== expected) fail(`Metadata ${key} must be ${expected}.`);
  if (!Array.isArray(system.tools) || !system.tools.every(text) || !object(system.params) || typeof system.system_prompt !== "string") fail("Metadata tools, params or system_prompt shape is invalid.");
  if (!text(content.instruction) || !content.instruction.includes("aisp_contract") || !content.instruction.includes("RUN aisop.main") || typeof content.user_input !== "string") fail("Instruction must reference aisp_contract and RUN aisop.main; user_input must be a string.");
  const contract = content.aisp_contract;
  if (!object(contract) || contract.profile !== "aisp.skill.v1" || !object(contract.invocation) ||
      !strings(contract.invocation.when_to_use) || !strings(contract.invocation.when_not_to_use) ||
      !["auto_or_manual", "manual_only", "auto_preferred", "internal_only"].includes(contract.invocation.mode)) fail("Invalid contract profile or invocation metadata.");
  if (!object(content.aisop) || Object.keys(content.aisop).join(",") !== "main" || !object(content.aisop.main)) return [...errors, "Pilot supports a single main JSON flow."];
  if (!object(content.functions)) return [...errors, "functions must be an object."];
  const nodes = content.aisop.main; const functions = content.functions; const graph = new Map();
  const names = Object.keys(nodes);
  if (names[0] !== "scope") fail("Pilot entry must be the first node, scope.");
  for (const [name, node] of Object.entries(nodes)) {
    if (!object(node)) { fail(`${name}: node must be an object.`); continue; }
    if (Object.keys(node).some(key => !["next", "branches"].includes(key))) fail(`${name}: unsupported topology field.`);
    let targets = [];
    if ("next" in node) {
      if (Object.keys(node).length !== 1 || !strings(node.next) || node.next.length !== 1) fail(`${name}: only one sequence target is supported; parallel paths are unsupported.`);
      else targets = node.next;
    } else if ("branches" in node) {
      if (Object.keys(node).length !== 1 || !object(node.branches) || !strings(Object.values(node.branches))) fail(`${name}: invalid branches.`);
      else targets = Object.values(node.branches);
    }
    graph.set(name, targets);
    if (!Object.hasOwn(functions, name) || !object(functions[name])) fail(`${name}: missing function.`);
  }
  for (const [name, targets] of graph) for (const target of targets) if (!graph.has(target)) fail(`${name}: dangling target ${target}.`);
  if (![...graph.values()].some(targets => targets.length === 0)) fail("Flow has no terminal node.");
  const visited = reachable(graph, "scope");
  for (const name of names) if (!visited.has(name)) fail(`${name}: unreachable node.`);
  const reverse = new Map([...graph.keys()].map(name => [name, []]));
  for (const [name, targets] of graph) for (const target of targets) reverse.get(target)?.push(name);
  const terminals = [...graph].filter(([, targets]) => targets.length === 0).map(([name]) => name);
  const canFinish = reachable(reverse, terminals);
  for (const name of visited) if (!canFinish.has(name)) fail(`${name}: no path to a terminal.`);
  const approvals = new Map();
  for (const [name, body] of Object.entries(functions)) {
    if (!Object.hasOwn(nodes, name)) fail(`${name}: function has no node.`);
    if (!object(body)) { fail(`${name}: function must be an object.`); continue; }
    const steps = Object.keys(body).filter(key => /^step[1-9]\d*$/.test(key)).sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));
    if (!steps.length || steps.some((key, i) => key !== `step${i + 1}` || !text(body[key]))) fail(`${name}: numbered steps must be contiguous nonempty strings.`);
    const bindings = [];
    for (const [key, value] of Object.entries(body)) {
      if (steps.includes(key)) {
        if (!text(value)) continue;
        const parsed = call(value);
        if (value.trim().startsWith("RUN aisop.") || (value.trim().startsWith("sys.") && (!parsed || !["sys.io.confirm", "sys.assert", "sys.state.set"].includes(parsed.name)))) fail(`${name}.${key}: unsupported execution operation.`);
        if (parsed?.name === "sys.io.confirm") {
          const binding = approvalBinding(name, body, key);
          if (!binding) fail(`${name}: approval requires confirmation state followed immediately by an approve-only assertion.`);
          else bindings.push(binding);
        }
      } else if (!["constraints", "output_mapping", "execute_mode"].includes(key)) fail(`${name}.${key}: unsupported function behavior.`);
    }
    if ("execute_mode" in body && body.execute_mode !== "inline") fail(`${name}: unsupported execute_mode.`);
    if ("output_mapping" in body && !text(body.output_mapping)) fail(`${name}: output_mapping must be a string.`);
    if ("constraints" in body && !text(body.constraints) && !strings(body.constraints)) fail(`${name}: constraints must be text or a string array.`);
    approvals.set(name, bindings);
  }
  const rules = contract?.non_negotiable; const declared = new Set();
  if (!Array.isArray(rules) || !rules.length) fail("Contract needs non_negotiable enforcement bindings.");
  else for (const rule of rules) {
    if (!object(rule) || !text(rule.rule) || !text(rule.enforced_by)) { fail("Invalid non_negotiable rule or binding."); continue; }
    const binding = rule.enforced_by; declared.add(binding);
    if (binding === "aisop.main") continue;
    if (binding === "tools" && system.tools?.length) continue;
    const match = binding.match(/^(\w+)\.(step[1-9]\d*):(sys\.[\w.]+)$/);
    if (!match || !graph.has(match[1]) || call(functions[match[1]]?.[match[2]])?.name !== match[3]) fail(`Phantom enforcement binding: ${binding}.`);
  }
  // Result approval protects every completion exit, including newly declared
  // terminal nodes. Checking only the named end node permits an early exit.
  const policies = [...POLICIES, ...terminals.filter(name => name !== "end").map(name => ["review_result", name])];
  for (const [gate, target] of policies) {
    if (!visited.has(gate) || !visited.has(target)) fail(`${gate} and ${target} must be reachable.`);
    else if (reachable(graph, "scope", gate).has(target)) fail(`${gate} must dominate ${target}; a bypass path exists.`);
    // A module loop begins a new traversal; the initiative map approval persists.
    if (["plan", "tasks", "implement"].includes(target) && graph.has("next_module") && reachable(graph, "next_module", gate).has(target))
      fail(`next_module: new module can reach ${target} without gate ${gate}.`);
    if (!approvals.get(gate)?.length) fail(`${gate}: missing executable approval gate.`);
    else if (!approvals.get(gate).some(binding => declared.has(binding))) fail(`${gate}: approval assertion requires a non_negotiable binding.`);
  }
  if (contract?.resources !== undefined && (!Array.isArray(contract.resources) || contract.resources.length)) fail("External resources are unsupported in this pilot.");
  return errors;
}

function renderBridge(program) {
  const system = program[0].content;
  return `---
name: spec-driven-development
description: ${JSON.stringify(system.description)}
license: ${JSON.stringify(system.license)}
metadata:
  generated_from_aisp: "true"
  aisp_program: aisp.aisop.json
  protocol: ${JSON.stringify(system.protocol)}
  bridge_mode: native_sidecar
---

<!-- Generated from aisp.aisop.json by experiments/309/check.js. Do not edit. -->
# Spec-Driven Development (Issue #309 Pilot)

${system.summary}

This SKILL.md is a thin discovery bridge, not the source of truth. The same-folder AISP program is canonical.
Read [aisp.aisop.json](aisp.aisop.json), inspect its user.content.aisp_contract, and follow user.content.aisop.main as declared before using this isolated pilot.
A generic Agent Skills host can follow the contract on a best-effort basis. Hard confirmation, assertion, dispatch, and tool guarantees require a conforming AISP/AISOP runtime. This bridge is a discovery and loading guide.
`;
}
function renderReadme(program) {
  const system = program[0].content; const contract = program[1].content.aisp_contract;
  return `<!-- generated_from_aisp: true -->
<!-- source: aisp.aisop.json -->
<!-- generator: experiments/309/check.js -->
<!-- Generated locally from the canonical JSON. Do not edit. -->
# ${system.name}

${system.summary}

Canonical source: [aisp.aisop.json](aisp.aisop.json). The adjacent [SKILL.md](SKILL.md) is a generated discovery bridge.

| Metadata | Value |
| --- | --- |
| ID | ${system.id} |
| Protocol | ${system.protocol} |
| Version | ${system.version} |
| License | ${system.license} |
| Invocation | ${contract.invocation.mode} |

Use when:
${contract.invocation.when_to_use.map(value => `- ${value}`).join("\n")}

Do not use when:
${contract.invocation.when_not_to_use.map(value => `- ${value}`).join("\n")}

This package is an isolated authoring and static-validation experiment. The local checker does not execute the workflow, implement a runtime, prove human approval, or claim complete AISP conformance. Deterministic confirmation and assertions require an AISOP-compatible executor. Behavioral evals remain necessary.

Run from the repository root:

\`\`\`sh
node experiments/309/check.js --check
node --test experiments/309/check-test.js
# Regenerate both Markdown projections after editing the canonical JSON:
node experiments/309/check.js --write
\`\`\`
`;
}
function loadBundle(dir) { return JSON.parse(normalize(fs.readFileSync(path.join(dir, "aisp.aisop.json"), "utf8"))); }
function checkBundle(dir, { write = false, root = path.dirname(path.resolve(dir)) } = {}) {
  // Check every source/destination before updating either projection. The CLI
  // anchors this walk at the checkout, including the aisp/ parent directory.
  try {
    for (const name of ["aisp.aisop.json", "SKILL.md", "README.md"]) assertEvalFile(path.join(dir, name), root);
  } catch { return ["Unsafe or linked canonical source or generated projection."]; }
  let program;
  try { program = loadBundle(dir); } catch { return ["Cannot read canonical program; input excerpt and path withheld."]; }
  const errors = validateProgram(program);
  if (path.basename(path.resolve(dir)) !== ID) errors.push(`Bundle folder must match id ${ID}.`);
  if (errors.length) return errors;
  const projections = [["SKILL.md", renderBridge(program)], ["README.md", renderReadme(program)]];
  for (const [name, expected] of projections) {
    const file = path.join(dir, name);
    if (write) writeEvalArtifact(file, expected, root);
    else {
      try { if (normalize(fs.readFileSync(file, "utf8")) !== expected) errors.push(`${name}: generated projection drift; run --write.`); }
      catch { errors.push(`${name}: missing projection; run --write.`); }
    }
  }
  return errors;
}
module.exports = { validateProgram, renderBridge, renderReadme, loadBundle, checkBundle };
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && !["--check", "--write"].includes(args[0]))) {
    console.error("Usage: node experiments/309/check.js [--check|--write]"); process.exitCode = 1;
  } else {
    try {
      const errors = checkBundle(DEFAULT_DIR, { write: args[0] === "--write", root: ROOT });
      if (errors.length) { console.error(errors.map(message => redactEvidenceText(message, { repositoryRoot: ROOT })).join("\n")); process.exitCode = 1; }
      else console.log("Issue #309 pilot checks passed; no runtime enforcement evaluated.");
    } catch { console.error("Pilot check or generation failed; private error details withheld."); process.exitCode = 1; }
  }
}
