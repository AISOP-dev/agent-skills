# Single-source workflow experiment

This pilot evaluates the AISP-first option in [issue #309](https://github.com/addyosmani/agent-skills/issues/309#issuecomment-5711889443). It supplies one canonical JSON program, derived discovery files, and a deterministic check for declared approval bypasses. It is outside `skills/`, so it is not installed or routed as another production skill.

The comparison baseline is `skills/spec-driven-development/SKILL.md`. The candidate is `aisp/spec_driven_development_aisp/aisp.aisop.json`. Each arm has its own authored source; the candidate's `SKILL.md` and package `README.md` are generated projections, never independently edited workflow definitions.

## Run the experiment

From the repository root, using Node.js 24:

```bash
node --test experiments/309/check-test.js scripts/run-evals-test.js scripts/run-evals-boundary-test.js scripts/run-evals-privacy-test.js
node experiments/309/check.js --check
```

After deliberately editing the canonical program, regenerate its projections:

```bash
node experiments/309/check.js --write
```

Behavioral runs use the existing runner and the same independently authored case file for both arms. They spend model tokens and run only on demand:

```bash
node scripts/run-evals.js --behavioral spec-driven-development --dry-run
node scripts/run-evals.js --behavioral spec-driven-development --skill-dir experiments/309/aisp/spec_driven_development_aisp --dry-run
node scripts/run-evals.js --behavioral spec-driven-development
node scripts/run-evals.js --behavioral spec-driven-development --skill-dir experiments/309/aisp/spec_driven_development_aisp
```

The alternate directory is opt-in. Its required `eval-bundle.json` lists only `SKILL.md`, `README.md`, and `aisp.aisop.json`; `SKILL.md` must be listed. The runner copies these allowed text files into a fresh fixture workspace, supplies relative installed paths, and does not inject the JSON program directly. Unlisted files and the manifest itself are not copied. This is an evaluation transport list, not a second workflow definition.

Candidate grading and projected traces are kept separate from the baseline under `evals/results/skill-dir/`. All grader input and saved candidate traces use an allowlisted, redacted projection; the runner does not retain raw CLI output or offer a raw opt-in. Invalid grader output produces only a generic `grading.error.json`. Run metadata records relative source and installed paths, executor model, and CLI version. Inspect the projected trace for a real read of the canonical program as well as the behavior being graded.

The grader runs from a separate empty temporary directory with file and command tools disabled (`--tools ''`). Both executor and grader calls request that the CLI not save local sessions (`--no-session-persistence`); this does not control provider retention or remove existing historical logs. This is not a complete Claude Code sandbox: automatic CLI context or configuration may still apply, and the executor can send its prompt, bridge, and explicitly read file contents to the provider. Review inputs and projected reports before publishing; redaction and Git ignore cannot establish that arbitrary content is non-confidential.

For comparable runs, pin the CLI's `ANTHROPIC_MODEL` environment variable for both executor and grader. For example, set `ANTHROPIC_MODEL=claude-opus-5-5` before the commands above (PowerShell: `$env:ANTHROPIC_MODEL = 'claude-opus-5-5'`). The runner reports the executor's observed identity; the grader identity remains `unknown` when its response does not expose it.

## What the checks establish

`check.js` is a bounded check for this experiment, not an AISP implementation or general validator. It checks the pilot's supported JSON-flow topology and independently specified review requirements. Removing a required review node must make its protected phase unreachable. Regression tests add a direct bypass, alter approval guards, and introduce unsupported topology to verify rejection.

The five human-review requirements are specification review before planning, plan review before tasks, task review before implementation, map review before module preparation, and result review before module advancement or any terminal exit. The first three are also checked from the declared `next_module` loop entry. Regression tests exercise direct and conditional bypasses, additional terminal nodes, missing enforcement bindings, and later-module entry. This does not prove that live approvals match the current module, revision, or turn.

The supported topology is a single `main` JSON-flow graph with sequential edges, ordinary conditional branches, and terminal nodes. It does not model parallel joins, delegated graphs, error routing, retry policies, or substitute execution. Unsupported constructs fail instead of receiving a misleading approval. Graph checks establish properties of the declared program; they do not prove that an agent traversed it or that a human approved an artifact.

Both baseline and candidate dry-run preflight run in CI on Ubuntu, Windows, and macOS. They validate the checked-in manifest and every shared case without probing Claude or making model calls.

Projection checks establish derivation consistency. Bundle tests establish that the installed bridge can resolve the colocated JSON after relocation. Neither is evidence of runtime enforcement or full semantic equivalence.

The generator validates the canonical source and both projection destinations before writing either file. Its CLI rejects linked ancestors and hardlinked files, uses atomic file replacement, and withholds raw JSON syntax excerpts and filesystem error details. These checks protect local authoring files; the two projection replacements are not a single transaction.

## Offline regression coverage

This experiment depends on the separately reviewable evaluator hardening change. The general transport controls and their offline regression coverage are documented in [Skill Evals](../../evals/README.md#offline-runner-regression-coverage); they are not an AISOP runtime.

The experiment's own regressions cover all five approval gates, direct and conditional bypasses, later-module entry, additional terminal nodes, missing or false enforcement bindings, unsupported topology, and deterministic projections. Generator tests reject linked sources and destinations and hardlinked files, withhold raw JSON syntax and filesystem details, and ensure rejected inputs cannot overwrite unrelated records. The transport's shared file guards and redaction helper are reused rather than copied into the experiment.

The current offline snapshot was validated on 2026-10-11 with Node.js 24.15.0:

| Native environment | Node tests passed | Failed | Skipped |
|---|---|---|---|
| Windows | 579 | 0 | 0 |
| Ubuntu WSL, Linux filesystem | 577 | 0 | 2 Windows-only NTFS stream tests |

All seven repository validators passed on both environments; routing stayed at 89/89 rank-1. Linux also passed session-start payload tests with and without jq, all 29 sdd-cache assertions, and all 58 simplify-ignore assertions. The Linux snapshot preserved checkout LF normalization and Git file modes, used an isolated home and Git configuration, and ran with networking disabled in a dedicated network namespace. macOS and live Claude integration have not been run against this snapshot. Historical model results below refer to the earlier runner.

## Semantic review map

This table is a review checklist, not another workflow definition. The production Markdown remains the comparison oracle; review the candidate's node instructions against it.

| Existing behavior | Candidate area to inspect |
|---|---|
| Applicability and exclusions | Contract invocation |
| Conditional capability decomposition and map approval | Scope, capability-map, and map-review nodes |
| Stable module ids, dependency direction, module-scoped specs | Map and module preparation |
| Clarification and explicit assumptions before content | Specify instructions |
| Six spec areas, testable success criteria, and boundaries | Specify instructions and constraints |
| Existing OpenSpec or other artifact conventions | Specify instructions |
| Save spec, request approval, and end the turn before planning | Specify and specification review |
| Planning skill owns mechanics; plan/task output conventions | Plan and task instructions |
| Incremental implementation, TDD, and context loading | Implementation handoffs |
| Living spec, version control, and traceability | Implementation and verification |
| Rationalizations, red flags, and completion evidence | Node constraints and verification |

The shared behavioral cases separately check the initial spec boundary, capability-map boundary, and pressure to continue without approval. A single `claude -p` call cannot demonstrate later-turn approval, rejection/resumption, stale approval invalidation, every module transition, or every downstream skill handoff. These remain necessary evidence before any production migration.

## Protocol and compatibility boundaries

The protocol snapshots used for this pilot are [AISOP V1.0.0](https://github.com/AIXP-Labs/AISOP/blob/377ad24ffd88d76de9494f71f9311287877dc071/specification/aisop-spec.md) and [AISP V1.0.0](https://github.com/AIXP-Labs/AISP/blob/68777bf65b2229148d599a4abbe2fa931fb756a8/specification/AISP_Protocol.md). AISP's native `_aisp` folder naming and thin sidecar are deliberate here; the production catalog's name/directory and section rules remain applicable to production Markdown skills.

A generic Agent Skills host may discover the bridge and follow the program on a best-effort basis. Hard confirmation, assertions, state transfer, dispatch, and resource permissions require a conforming AISP/AISOP runtime. This PR adds no runtime. In particular, a passing package validator cannot establish that the runtime used an enforcement binding; see the official [validator coverage](https://github.com/AIXP-Labs/AISP/blob/68777bf65b2229148d599a4abbe2fa931fb756a8/docs/reference/validator-coverage.md).

The official AISP reference tools can be used independently from their pinned checkout:

```bash
python -B tools/aisp_validate.py --json /path/to/this/repo/experiments/309/aisp/spec_driven_development_aisp
python -B tools/aisp_validate_agent_skill_bridge.py --json /path/to/this/repo/experiments/309/aisp/spec_driven_development_aisp
```

The pilot checks do not implement every M, R, SE, or EC rule. A reference-tool result and a local check result should be reported separately. The generated projections use a local deterministic generator; their shape is reviewed against the sidecar rules, rather than claiming byte equality with the official generator.

## Decision criteria

Adoption needs evidence that the structured source preserves the existing behavior, exposes useful invariants beyond current eval coverage, and earns its authoring/loading cost. The pilot does not add a router or duplicate the catalog generation proposed in [PR #548](https://github.com/addyosmani/agent-skills/pull/548).

The opt-in loader stages only the selected self-contained bundle's manifest-listed text files. It does not implement the default production/shared-reference staging discussed in [#584](https://github.com/addyosmani/agent-skills/issues/584), or the historical record/regrade workflow in [#667](https://github.com/addyosmani/agent-skills/pull/667).

Measured results belong below with the exact input snapshot, CLI/model identity, and limitations. Deterministic success alone is not a reason to migrate the production skill.

## Results

The following six historical model runs used the runner before the privacy fixes described above. Their raw logs and grading artifacts were removed locally during privacy remediation; the summary and input hashes below remain, but these figures cannot be independently regraded from this checkout. Local Windows validation on 2026-10-11 used Node.js 24.15.0 and Claude Code 2.1.296. Both arms requested `claude-opus-5-5` through `ANTHROPIC_MODEL`, and all six executor traces reported that model. Each case was run once per arm; this is a loading/behavior smoke comparison, not a statistically reliable adherence or performance benchmark. The revised runner is validated offline only; no external model comparison has been repeated against it.

| Independent case | Markdown baseline | AISP bridge | Baseline / candidate executor elapsed | Candidate canonical JSON reads |
|---|---|---|---|---|
| Single-capability spec and stop | 7/7 | 7/7 | 39.6s / 53.6s | 1 |
| Multi-capability map and stop | 5/5 | 5/5 | 28.1s / 32.0s | 1 |
| Single-capability time pressure | 5/5 | 5/5 | 34.1s / 37.9s | 1 |

The bridge loaded the canonical JSON through a real `Read` in all three cases and preserved these initial approval boundaries. It added loading work: 16 executor tool calls versus 11, and mean elapsed 41.2s versus 33.9s. These observations do not establish a token or latency benefit, later-turn equivalence, runtime enforcement, or a reason to migrate production. The first exploratory billing case conflated multiple capabilities with a single-spec expectation; the comparison above uses an explicitly single-capability brief for spec/pressure cases and keeps decomposition as its own case.

Input SHA-256 snapshots:

| Input | SHA-256 |
|---|---|
| Production SKILL.md | `c4b97ce3d7f24be0e67fd612c7595f65504872e3a9f8d338d098b2363fdb66ef` |
| Candidate aisp.aisop.json | `72599e4c2c9825d01b6f8eb8576bacaa822cc753f49edf727afd6b66d2a8841e` |
| Shared case file | `e576e9b31d9bc54398e860bc8f87c48a3323e6b4b1da93606bd7aa20a803bec6` |

At the historical comparison snapshot, all 228 Node regression tests passed, including 27 pilot checks and 47 runner tests. Production structural, version, command, reference, and artifact-path validators passed; routing remained 89/89 rank-1. Official AISP package validation reported zero failures and two EC8 warnings because the local README projection differs from the reference generator. Official sidecar validation reported zero failures and zero warnings. R1-R7 runtime behavior was not evaluated; a strict reference README release check is not claimed. The offline commands above also cover the new privacy regression tests, with mocked executor and grader calls.

New candidate runs persist only the projected trace and grading; the baseline runner remains grading-only. All results are gitignored and require review before publication. Git ignore is an accidental-staging guard, not a redaction guarantee. Provider retention and previously transmitted data are outside these local cleanup and transport controls.
