"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { validateProgram, renderBridge, renderReadme, loadBundle, checkBundle } = require("./check");
const { loadSkillBundle } = require("../../scripts/lib/eval-workspace");

const id = "spec_driven_development_aisp";
const gates = { review_spec: "spec_decision", review_plan: "plan_decision", review_tasks: "tasks_decision", review_map: "map_decision", review_result: "result_decision" };

test("the real transport manifest includes the canonical program and both projections", () => {
  const bundle = loadSkillBundle("spec-driven-development", "experiments/309/aisp/spec_driven_development_aisp");
  assert.deepEqual([...bundle.files].sort(), ["README.md", "SKILL.md", "aisp.aisop.json"],
    "a generically valid SKILL-only bundle would omit this pilot's canonical source");
});

for (const candidate of [false, true]) {
  test(`the real ${candidate ? "candidate manifest" : "baseline case"} passes offline runner preflight`, () => {
    const repo = path.resolve(__dirname, "..", "..");
    const args = [path.join(repo, "scripts/run-evals.js"), "--behavioral", "spec-driven-development"];
    if (candidate) args.push("--skill-dir", "experiments/309/aisp/spec_driven_development_aisp");
    args.push("--dry-run");
    const result = spawnSync(process.execPath, args, { cwd: repo, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } });
    assert.equal(result.status, 0, "the checked-in package and cases must remain loadable without invoking a model");
    const ids = [...result.stdout.matchAll(/\[dry-run\] eval (\d+):/g)].map(match => Number(match[1]));
    assert.deepEqual(ids, [1, 2, 3], "CI must preflight every independently authored case in both arms");
    if (candidate) assert.match(result.stdout, /source: experiments\/309\/aisp\/spec_driven_development_aisp\/SKILL\.md/);
  });
}
function fixture() {
  const main = {
    scope: { branches: { single: "specify", multiple: "capability_map" } },
    capability_map: { next: ["review_map"] }, review_map: { next: ["prepare_module"] },
    prepare_module: { next: ["specify"] }, specify: { next: ["review_spec"] },
    review_spec: { next: ["plan"] }, plan: { next: ["review_plan"] },
    review_plan: { next: ["tasks"] }, tasks: { next: ["review_tasks"] },
    review_tasks: { next: ["implement"] }, implement: { next: ["verify"] },
    verify: { next: ["review_result"] }, review_result: { next: ["next_module"] }, next_module: { next: ["end"] }, end: {},
  };
  const functions = Object.fromEntries(Object.keys(main).map(node => [node, { step1: `Complete ${node}.` }]));
  for (const [node, decision] of Object.entries(gates)) functions[node] = {
    step1: `sys.io.confirm('Approve this artifact?', options=['approve', 'reject', 'modify']) -> ${decision}`,
    step2: `sys.assert('${decision} == "approve"', 'Approval required')`,
  };
  return [
    { role: "system", content: { protocol: "AISP V1.0.0", axiom_0: "Human_Sovereignty_and_Wellbeing", id,
      name: "Fixture pilot", description: "Creates specs before coding. Use when no specification exists.",
      version: "0.1.0", license: "MIT", summary: "An independent fixture.", flow_format: "jsonflow", loading_mode: "node", tools: [], params: {}, system_prompt: "" } },
    { role: "user", content: { instruction: "STRICTLY OBEY aisp_contract; then RUN aisop.main", user_input: "{user_input}",
      aisp_contract: { profile: "aisp.skill.v1", invocation: { mode: "auto_or_manual", when_to_use: ["Missing spec"], when_not_to_use: ["Typo fix"] },
        non_negotiable: Object.keys(gates).map(node => ({ rule: `Approve ${node}.`, enforced_by: `${node}.step2:sys.assert` })), resources: [] },
      aisop: { main }, functions } },
  ];
}
function reject(change, pattern) {
  const program = fixture(); change(program[1].content, program[0].content);
  assert.match(validateProgram(program).join("\n"), pattern);
}
function tempBundle(t) {
  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "issue309-check-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(sandboxRoot)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(sandboxRoot).startsWith("issue309-check-"));
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  });
  const root = path.join(sandboxRoot, "experiments", "309");
  const dir = path.join(root, "aisp", id); fs.mkdirSync(dir, { recursive: true });
  const program = fixture();
  fs.writeFileSync(path.join(dir, "aisp.aisop.json"), JSON.stringify(program));
  fs.writeFileSync(path.join(dir, "SKILL.md"), renderBridge(program));
  fs.writeFileSync(path.join(dir, "README.md"), renderReadme(program));
  fs.copyFileSync(path.join(__dirname, "check.js"), path.join(root, "check.js"));
  for (const name of ["eval-files.js", "eval-evidence.js"]) {
    const destination = path.join(sandboxRoot, "scripts", "lib", name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(__dirname, "..", "..", "scripts", "lib", name), destination);
  }
  return { root, dir, program };
}

for (const name of ["aisp.aisop.json", "SKILL.md", "README.md"]) {
  for (const write of [false, true]) {
    test(`${write ? "write" : "check"} rejects hardlinked ${name} before reading or changing projections`, t => {
      const { root, dir } = tempBundle(t);
      const file = path.join(dir, name); const foreign = path.join(root, "fictional-personal-record");
      fs.renameSync(file, foreign); fs.linkSync(foreign, file);
      const paths = [foreign, ...["SKILL.md", "README.md"].map(item => path.join(dir, item))];
      const before = paths.map(item => fs.readFileSync(item, "utf8"));
      assert.match(checkBundle(dir, { write }).join("\n"), /unsafe|linked/i);
      assert.deepEqual(paths.map(item => fs.readFileSync(item, "utf8")), before);
    });
  }
}

test("canonical JSON syntax diagnostics contain no raw input excerpt", t => {
  const { dir } = tempBundle(t);
  fs.writeFileSync(path.join(dir, "aisp.aisop.json"), "PRIVATEKEY");
  const diagnostic = checkBundle(dir).join("\n");
  assert.ok(!diagnostic.includes("PRIVATEKEY"));
  assert.match(diagnostic, /canonical program/);
});

test("CLI refuses a linked source parent without overwriting unrelated files", t => {
  const { root } = tempBundle(t);
  const original = path.join(root, "aisp"); const foreign = path.join(root, "fictional-external-bundles");
  fs.renameSync(original, foreign);
  fs.symlinkSync(foreign, original, process.platform === "win32" ? "junction" : "dir");
  const file = path.join(foreign, id, "SKILL.md"); const before = fs.readFileSync(file, "utf8");
  for (const option of ["--check", "--write"]) {
    const result = spawnSync(process.execPath, [path.join(root, "check.js"), option], { encoding: "utf8" });
    assert.notEqual(result.status, 0, "a linked parent is not a canonical source directory");
    assert.ok(!result.stderr.includes(root), "diagnostics must not contain private filesystem paths");
    assert.equal(fs.readFileSync(file, "utf8"), before);
  }
});

test("independent fixture satisfies all five human review requirements", () => assert.deepEqual(validateProgram(fixture()), []));
test("the real candidate validates and preserves the baseline router description", () => {
  const dir = path.join(__dirname, "aisp", id); const program = loadBundle(dir);
  const baseline = fs.readFileSync(path.join(__dirname, "..", "..", "skills", "spec-driven-development", "SKILL.md"), "utf8");
  assert.deepEqual(validateProgram(program), []);
  assert.equal(program[0].content.description, baseline.match(/^description: (.+)$/m)[1].trim());
});
for (const target of ["next_module", "end"]) test(`implementation results cannot bypass human review before ${target}`, () => {
  const program = loadBundle(path.join(__dirname, "aisp", id));
  program[1].content.aisop.main.verify = { branches: { reviewed: "review_result", bypass: target } };
  assert.match(validateProgram(program).join("\n"), new RegExp(`review_result.*${target}`));
});
test("result review requires its own declared enforcement binding", () => {
  const program = loadBundle(path.join(__dirname, "aisp", id));
  program[1].content.aisp_contract.non_negotiable = program[1].content.aisp_contract.non_negotiable
    .filter(rule => !rule.enforced_by.startsWith("review_result."));
  assert.match(validateProgram(program).join("\n"), /review_result.*binding/);
});
test("an additional terminal cannot declare completion without result review", () => {
  const program = loadBundle(path.join(__dirname, "aisp", id));
  program[1].content.aisop.main.verify = { branches: { reviewed: "review_result", bypass: "early_finish" } };
  program[1].content.aisop.main.early_finish = {};
  program[1].content.functions.early_finish = { step1: "Declare the implementation complete." };
  assert.match(validateProgram(program).join("\n"), /review_result.*early_finish/);
});
for (const target of ["plan", "tasks", "implement"]) test(`later-module entry at ${target} cannot reuse an earlier module's gate traversal`, () => {
  const program = loadBundle(path.join(__dirname, "aisp", id));
  program[1].content.aisop.main.next_module.branches.more = target;
  assert.match(validateProgram(program).join("\n"), /next_module.*gate|gate.*next_module/);
});
test("graph nodes require own function definitions, including prototype-looking names", () => reject(c => {
  c.aisop.main.scope.branches.extra = "__proto__";
  Object.defineProperty(c.aisop.main, "__proto__", { value: {}, enumerable: true });
}, /__proto__.*missing function/));
test("single-capability route may skip only the capability-map gate", () => {
  const p = fixture(); p[1].content.aisop.main.implement = { branches: { retry: "specify", done: "verify" } };
  assert.deepEqual(validateProgram(p), []);
});
for (const [gate, target] of [["review_spec", "plan"], ["review_plan", "tasks"], ["review_tasks", "implement"], ["review_map", "prepare_module"], ["review_result", "next_module"], ["review_result", "end"]]) {
  test(`rejects direct and conditional bypass of ${gate}`, () => {
    reject(c => { c.aisop.main.scope.branches.shortcut = target; }, new RegExp(`${gate}.*${target}|${target}.*${gate}`));
    const previous = { review_spec: "specify", review_plan: "plan", review_tasks: "tasks", review_map: "capability_map", review_result: "verify" }[gate];
    reject(c => { c.aisop.main[previous].next = [target]; }, new RegExp(`${gate}.*${target}|${target}.*${gate}`));
  });
}
test("rejects a gate label without executable approval state", () => reject(c => { c.functions.review_spec = { step1: "Ask for approval." }; }, /review_spec.*approval/));
test("rejects reject/modify results mistaken for approval", () => reject(c => {
  c.functions.review_spec.step2 = "sys.assert('spec_decision != null', 'Approval required')";
}, /review_spec.*approval/));
test("rejects non-adjacent confirmation and assertion", () => reject(c => {
  c.functions.review_spec.step3 = c.functions.review_spec.step2; c.functions.review_spec.step2 = "Proceed anyway.";
}, /review_spec.*approval/));
test("malformed adjacent assertion produces diagnostics, not an exception", () => reject(c => {
  c.functions.review_spec.step2 = { assertion: "spec_decision == approve" };
}, /review_spec.*approval/));
test("rejects removed or phantom enforcement bindings", () => {
  reject(c => { c.aisp_contract.non_negotiable = []; }, /non_negotiable|binding/);
  reject(c => { c.aisp_contract.non_negotiable[0].enforced_by = "review_spec.step99:sys.assert"; }, /binding/);
  reject(c => { c.aisp_contract.non_negotiable[0].enforced_by = "review_spec.step1:sys.assert"; }, /binding/);
});
test("rejects missing functions, targets, terminals, and unreachable nodes", () => {
  reject(c => { delete c.functions.plan; }, /plan.*function/);
  reject(c => { c.aisop.main.implement.next = ["missing"]; }, /missing.*target|dangling/);
  reject(c => { c.aisop.main.end = { next: ["scope"] }; }, /terminal/);
  reject(c => { c.aisop.main.orphan = {}; c.functions.orphan = { step1: "Unused." }; }, /orphan.*unreachable/);
  reject(c => { c.aisop.main.scope.branches.stuck = "loop"; c.aisop.main.loop = { next: ["loop"] }; c.functions.loop = { step1: "Wait forever." }; }, /loop.*terminal/);
});
test("rejects unsupported topology and hidden execution paths", () => {
  for (const field of ["delegate_to", "error", "wait_for", "mystery"]) reject(c => { c.aisop.main.plan[field] = "end"; }, /unsupported/);
  reject(c => { c.aisop.main.plan.next = ["tasks", "end"]; }, /parallel|sequence/);
  for (const field of ["map", "join", "on_error", "retry_policy"]) reject(c => { c.functions.plan[field] = {}; }, /unsupported/);
  for (const text of ["sys.unknown()", "sys.run('echo hi')", "RUN aisop.hidden"]) reject(c => { c.functions.plan.step1 = text; }, /unsupported/);
});
test("rejects malformed metadata, contract, roles and multiple tasks", () => {
  for (const key of ["protocol", "id", "license", "description"]) reject((c, s) => { delete s[key]; }, new RegExp(key));
  reject(c => { c.aisp_contract.invocation.when_to_use = []; }, /invocation/);
  reject(c => { c.aisop.hidden = {}; }, /single main/);
  assert.ok(validateProgram({}).length);
  const p = fixture(); p[1].role = "system"; assert.ok(validateProgram(p).length);
});
test("thin bridge has an independent expected header and relative source", () => {
  const p = fixture(); const bridge = renderBridge(p);
  assert.ok(bridge.startsWith('---\nname: spec-driven-development\ndescription: "Creates specs before coding. Use when no specification exists."\n'));
  assert.match(bridge, /Generated/); assert.match(bridge, /Read.*aisp\.aisop\.json/);
  assert.doesNotMatch(bridge, /review_spec|sys\.assert|SPECIFY.*PLAN/);
  assert.equal(renderBridge(p), bridge); assert.equal(renderReadme(p), renderReadme(p));
  assert.match(renderReadme(p), /not.*runtime|does not.*execute/i);
});
test("native bridge declares source ownership and the AISP runtime boundary", () => {
  const bridge = renderBridge(fixture());
  for (const line of ['license: "MIT"', '  generated_from_aisp: "true"', '  aisp_program: aisp.aisop.json', '  protocol: "AISP V1.0.0"', '  bridge_mode: native_sidecar'])
    assert.ok(bridge.split("\n").includes(line), `Missing native-sidecar declaration: ${line}`);
  assert.match(bridge, /thin.*bridge.*not the source of truth/i);
  assert.match(bridge, /An independent fixture\./);
  assert.match(bridge, /user\.content\.aisp_contract/); assert.match(bridge, /user\.content\.aisop\.main/);
  assert.match(bridge, /best-effort/); assert.match(bridge, /hard.*AISP\/AISOP runtime/i);
});
test("README declares canonical provenance and its actual local generator", () => {
  const readme = renderReadme(fixture());
  assert.ok(readme.includes("<!-- generated_from_aisp: true -->"));
  assert.ok(readme.includes("<!-- source: aisp.aisop.json -->"));
  assert.ok(readme.includes("<!-- generator: experiments/309/check.js -->"));
  assert.doesNotMatch(readme, /generator: tools\/aisp_readme\.py/);
});
test("loads relocated JSON using the bridge metadata path", t => {
  const { dir, program } = tempBundle(t);
  const bridge = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8");
  const relative = bridge.match(/aisp_program: (\S+)/)[1];
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, relative), "utf8")), program);
  assert.deepEqual(loadBundle(dir), program); assert.deepEqual(checkBundle(dir), []);
});
test("BOM and CRLF do not create projection drift", t => {
  const { dir, program } = tempBundle(t);
  for (const [name, text] of [["aisp.aisop.json", JSON.stringify(program)], ["SKILL.md", renderBridge(program)], ["README.md", renderReadme(program)]])
    fs.writeFileSync(path.join(dir, name), "\uFEFF" + text.replace(/\n/g, "\r\n"));
  assert.deepEqual(checkBundle(dir), []);
});
test("check reports drift and never writes projections", t => {
  const { root, dir } = tempBundle(t); const file = path.join(dir, "SKILL.md"); fs.appendFileSync(file, "drift\n");
  const before = fs.readFileSync(file, "utf8");
  assert.match(checkBundle(dir).join("\n"), /SKILL\.md.*drift/);
  const result = spawnSync(process.execPath, [path.join(root, "check.js"), "--check"], { encoding: "utf8" });
  assert.notEqual(result.status, 0); assert.equal(fs.readFileSync(file, "utf8"), before);
});
test("CLI writes stable projections, defaults to check, and rejects unknown arguments", t => {
  const { root, dir } = tempBundle(t);
  assert.equal(spawnSync(process.execPath, [path.join(root, "check.js"), "--write"]).status, 0);
  const files = ["aisp.aisop.json", "SKILL.md", "README.md"].map(name => path.join(dir, name));
  const before = files.map(file => [fs.readFileSync(file, "utf8"), fs.statSync(file).mtimeMs]);
  for (const args of [[], ["--check"]]) assert.equal(spawnSync(process.execPath, [path.join(root, "check.js"), ...args]).status, 0);
  assert.deepEqual(files.map(file => [fs.readFileSync(file, "utf8"), fs.statSync(file).mtimeMs]), before);
  assert.notEqual(spawnSync(process.execPath, [path.join(root, "check.js"), "--unknown"]).status, 0);
  assert.deepEqual(checkBundle(dir), []);
});
test("invalid --write leaves both existing projections untouched", t => {
  const { root, dir, program } = tempBundle(t); program[1].content.aisop.main.scope.branches.shortcut = "implement";
  fs.writeFileSync(path.join(dir, "aisp.aisop.json"), JSON.stringify(program));
  const files = ["SKILL.md", "README.md"].map(name => path.join(dir, name)); const before = files.map(file => fs.readFileSync(file, "utf8"));
  assert.notEqual(spawnSync(process.execPath, [path.join(root, "check.js"), "--write"]).status, 0);
  assert.deepEqual(files.map(file => fs.readFileSync(file, "utf8")), before);
});
