# Skill Evals

How this repo measures whether its skills actually work: that they **trigger** when they should, **stay distinct** from each other, and **change agent behavior** the way each skill promises.

## Prior art (and what we adopted)

There is no single settled community standard for evaluating `SKILL.md` skills, but two approaches lead:

- **Anthropic's skill-creator v2** defines a per-skill `evals.json` (prompt + `expectations[]`, graded from the transcript) plus trigger-accuracy testing of descriptions against sample prompts. We adopt its [`evals.json` schema](https://github.com/anthropics/skills/tree/main/skills/skill-creator) for our behavioral tier and add one optional `kind` field to select the artifact being graded.
- **Superpowers** (obra) tests skills with bash + `claude -p` + prompt fixtures and grader scripts. Our behavioral runner follows the same headless-`claude` pattern, with the grading rubric drawn from `expectations[]`.

What neither provides is a **deterministic, CI-safe** check for a multi-skill *catalog* — does each skill's description carry the vocabulary users actually say, and do two skills' descriptions collide? That's Tier 2 below, and it's this repo's addition.

## The three tiers

| Tier | What it checks | Runs | Cost |
|---|---|---|---|
| 1. Structural | Frontmatter, naming, required sections, command parity | CI (`validate-skills.js`, `validate-commands.js`) | Free |
| 2. Trigger & routing | Positive prompts rank their skill top-k; negative prompts don't; no two descriptions near-collide | CI (`run-evals.js`) | Free |
| 3. Behavioral | An agent following the skill satisfies its `expectations[]` | On demand (`run-evals.js --behavioral`) | Tokens |

Tier 2 is a **lexical approximation** of routing (stemmed TF-IDF over descriptions). It cannot judge semantics — that's Tier 3's job — but it catches the two failure modes that dominate real trigger bugs: a description missing the vocabulary users say (false negative), and an over-broad description that outranks the right skill (false positive). A Tier-2 failure usually means *fix the description*, not the eval.

## Running

```bash
# Tier 2 — deterministic, runs in CI
node scripts/run-evals.js
node scripts/run-evals.js --min-rank1 95  # enforce the current routing floor

# Tier 3 — behavioral, runs each eval through headless claude, then grades it
node scripts/run-evals.js --behavioral test-driven-development            # spends tokens
node scripts/run-evals.js --behavioral test-driven-development --dry-run  # prints the plan only
```

Tier 3 supports two behavioral artifact kinds. `execution` is the default: each eval runs in a throwaway git repository, project inputs from `files[]` are materialized out of `evals/fixtures/` and committed as the baseline, and the grader judges selected execution evidence, including tool calls. `dialogue` is reserved for skills whose deliverable is the conversation itself; it needs no fixture, and the grader judges the assistant's conversational turns without requiring file edits or commands. When a dialogue case declares `files[]`, those inputs are materialized too. Claiming `dialogue` is a human-reviewed exemption, not a general escape hatch for execution skills.

The executor runs with an explicit permission mode (`--permission-mode acceptEdits` plus a pre-approved tool list) so execution evals can edit files, run commands, inspect diffs, and make commits. Fixture Git setup uses an empty template, disables hooks locally, and ignores host Git configuration and `GIT_*` redirection variables; it does not change personal configuration. All grader input passes through an allowlisted, redacted projection of the expectations and execution or dialogue evidence. That projection omits unnecessary CLI/session metadata, redacts local paths and recognized credential patterns, and is fenced as untrusted data and passed over stdin. Short known private configuration names and their case variants are also filtered. The grader runs from a separate empty temporary directory with its file and command tools disabled (`--tools ''`). Executor and grader calls carry timeouts.

Empty execution output, reported executor failures, and malformed error states produce static diagnostics without starting a grader. A failed individual tool call can still be graded as part of an otherwise completed execution. Unknown options, duplicate options, and extra positional arguments are rejected before execution; a misspelled `--dry-run` is an error.

The complete behavioral case is validated before CLI version probing or result-slot changes: case identity, nonempty prompts and expectations, expected output, kind, fixture lists, and unique nonnegative IDs must be valid. Provisional execution cases cannot run. Case files, baseline instructions, the fixture root, and selected inputs must remain within the checkout without linked ancestors or hardlinked files. An invalid later evaluation therefore cannot run an earlier one or clear its saved result.

Version probing, execution, and grading receive an environment that removes inherited Git repository/index/template redirection and disables personal Git configuration. Other CLI configuration, including explicit model selection, remains available. This isolates Git behavior and does not establish a complete model sandbox.

Fixture paths and selected trees must not traverse symlinks or junctions, contain hardlinked files, or supply `.git` metadata at any depth (case-insensitive). Working-tree patches are parsed with Git to reject symbolic-link modes on every host, and their realized trees are checked again before execution. Empty or fully ignored fixture trees still receive an empty baseline commit. Fixture selectors accept either slash convention on every host, while rejecting drive-relative paths, device names, alternate data streams, and trailing-dot or trailing-space aliases. Selected trees also require portable filenames. Result directories and files are checked again after execution and before writes; linked destinations are rejected. Artifact writes use owner-only temporary files where supported and atomic replacement, so an interrupted write cannot publish a partial grading file. The runner owns temporary directories before population starts, so setup failures still reach cleanup. Cleanup failures make the run fail and retain a static diagnostic; a prior setup or execution failure is preserved when cleanup also fails. These filesystem checks do not establish isolation against a concurrent hostile process.

Accepted grading is validated, projected, and redacted before being written to gitignored `evals/results/` in skill-creator's `grading.json` shape. Invalid grader responses produce only a generic `grading.error.json`; the runner does not save the raw response or offer a raw-trace retention opt-in. Both executor and grader calls request that the CLI not save local sessions (`--no-session-persistence`). These controls do not govern provider retention or make Claude Code a complete sandbox: it may still supply automatic configuration or context, and executor tools remain available. Prompts, bridge text, and files the executor reads can reach the model provider. Existing historical logs are not retroactively removed. Review inputs before opting in; redaction cannot recognize every confidential passage, and Git ignore does not prevent model transmission. Discipline skills also include cases for time pressure, sunk cost, and authority pressure to test whether the workflow holds when the prompt argues for skipping it.

### Alternate skill bundles

To compare the same behavioral cases against an isolated, self-contained candidate, pass `--skill-dir` with a repository-relative directory containing a matching `SKILL.md` and a required `eval-bundle.json` file list:

```bash
node scripts/run-evals.js --behavioral spec-driven-development --skill-dir path/to/candidate --dry-run
```

For example, a self-contained candidate can declare:

```json
{"files":["SKILL.md","README.md","program.json"]}
```

The list must include `SKILL.md` and contain individual allowed text files with portable names, not directories or globs. Case JSON and manifest JSON accept an optional UTF-8 BOM; baseline and candidate frontmatter also support BOM, CRLF, and quoted skill names. The runner stages only those files under `.eval-skills/<skill>` in the temporary workspace, excludes them from fixture Git evidence, and supplies relative installed paths alongside the bridge text. Both fixture and candidate copies transfer file contents without hidden NTFS alternate data streams. The manifest itself is evaluation transport metadata and is not copied. Unlisted files are not staged. Supporting files are read on demand rather than injected into the system prompt.

Candidate results and projected execution traces are isolated under `evals/results/skill-dir/<source-directory>/`. The trace uses the same allowlisted, redacted projection supplied to the grader; raw CLI output is not persisted. Run metadata records relative source and installed paths, CLI version, and observed executor model. A recorded read proves loading, not compliance with the file's instructions. Treat even projected results as reviewable data before publishing them.

Replace `path/to/candidate` with the selected bundle directory. The loader accepts only confined repository paths and rejects escaping paths, duplicate file entries, and symlinks or directory junctions. It does not stage production shared references; see [#584](https://github.com/addyosmani/agent-skills/issues/584) for that separate loading limitation. It is not a historical recording or regrading mode.

## Offline runner regression coverage

The runner dispatches in `scripts/run-evals.js`. Its helpers separate workspace and candidate loading (`scripts/lib/eval-workspace.js`), evidence and grading policy (`scripts/lib/eval-evidence.js`), and filesystem checks and atomic artifact writes (`scripts/lib/eval-files.js`).

Run the offline regressions with Node.js 24:

```bash
node --test scripts/run-evals-test.js scripts/run-evals-boundary-test.js scripts/run-evals-privacy-test.js
```

Tests intercept every Claude operation, including version probing, and use artificial responses. They cover both baseline and candidate paths: schema preflight before side effects; strict CLI options; portable fixture paths and binary copies; BOM/CRLF input; nested Git metadata, linked inputs and destinations, and Windows alternate streams; declared dialogue fixtures; Git environment isolation; cleanup and atomic-write failures; gradeability and strict grading validation; and redaction across grader input, traces, and saved reports. Long redaction inputs run in local Node subprocesses with a five-second limit. URL email filtering also classifies percent-encoded values, including malformed UTF-8 escapes, and removes the whole private component while keeping public host and parameter names. Dotted credential parameter names are filtered without consuming unrelated query fields. A negative routing owner must strictly outscore the tested skill; an alphabetical tie does not pass.

These tests verify local transport and failure handling. They do not establish live CLI compatibility, provider retention controls, or a complete sandbox.

## Plugin evals (Claude Code)

`claude plugin eval` (Claude Code 2.1.269 or later) loads the whole plugin, every skill at once, runs the cases under `evals/plugin/`, and scores each case with and without the plugin. It complements Tier 2 rather than replacing it: Tier 2 checks that a description carries the vocabulary users say; this checks that Claude Code's own router picks the skill on a natural prompt, and what the skill adds to the reply (the `Δ` column).

```bash
claude plugin eval . --no-publish                                          # every case, both arms, 3 runs each
claude plugin eval . --case code-review-fires --runs 1 --ablation none     # one cheap iteration on one case
```

A case is a directory holding `prompt.md` (frontmatter: turn and tool limits; body: the prompt, sent verbatim) and one grader per file under `graders/`. Reports land in `evals/plugin/results/<timestamp>/`, already gitignored. Every run and every `llm` grader is a real model call on your account, so this runs on demand and never in CI, like Tier 3.

Two rules keep it honest. The manifest's `experimental.evals` key scopes the scan to `evals/plugin/`, so a fixture elsewhere under `evals/` is never read as a case. And a `tool_used: Skill` grader only says whether the skill fired; in a two-arm run it is excluded from the score, so pair it with a grader on the reply itself. `code-review-fires` shows the pattern: the fired indicator, a free `regex` grader that looks for the skill's severity taxonomy (Critical, Required, Nit, Optional, Consider, FYI) used as a heading or as a label, and one `llm` judge on the planted off-by-one. `code-review-stays-quiet` is the precision check: the review skill must not fire on a test-first request, and its `Δ` is expected to be 0; a second, unscored indicator records whether test-driven-development fires instead.

What the first runs taught (Claude Code 2.1.278, claude-opus-5). Skill invocation is stochastic: the review skill fired in 5 of 7 runs on the phrasing the case uses, and test-driven-development fired in 2 of 7 runs on the test-first prompt, so read `Δ` and the report rather than the exit code, or pass `--threshold 0.8` as the CI example in the docs does. In one run the review skill did not fire and the reply still used its severity taxonomy as headings, which no baseline run did in nine; the loaded skill descriptions may shape the reply even without an invocation. Phrasing matters, and the description is the lever. With the original description, "Review this diff before I merge it", "Can you do a proper code review of this change before I merge it?" and "Review this pull request for me before it goes into main" rarely fired the skill; the model reviewed the diff on its own, competently but without the verdict, the severity tiers or the five-axis pass. Describing what the skill adds did not help, and neither did naming diffs and pull requests on their own; what made the difference was saying that the skill applies even when the diff is pasted inline, which is the case the model was treating as "I can just do this myself". On claude-opus-5-5 with the model pinned, that one clause took the four review phrasings from 7 of 27 fires to 21 of 27, left the nine adjacent must-not-fire prompts at 0 of 27 both ways, and moved the plainest phrasing from 0 of 9 to 3 of 9, so it is better, not solved. `code-review-stays-quiet-on-commit-message` guards that clause: a pasted diff with a commit-message request must not fire the review skill. Two practical rules from the same day: pin `--model` and record the Claude Code version whenever you report numbers, because the CLI updates itself and the default model changed twice between morning and evening; and give a case a turn budget of 10 or more, since the model may reach a skill through its slash command (`agent-skills:review`, then `code-review-and-quality`), which costs two turns.

## Eval case format

One file per skill: `evals/cases/<skill-name>.json`.

```json
{
  "skill_name": "test-driven-development",
  "trigger": {
    "positive": [
      { "prompt": "Write a failing test for this bug before fixing it", "top_k": 3 }
    ],
    "negative": [
      { "prompt": "Update the architecture diagram in the docs", "owner": "documentation-and-adrs" }
    ]
  },
  "evals": [
    {
      "id": 1,
      "kind": "execution",
      "prompt": "Finance filed the reconciliation bug written up in BUG.md. Fix it.",
      "expected_output": "A failing reproduction test for the lost-cent case, a fix preserving both README invariants (exact sum, earliest-shares fairness), the fairness invariant covered by its own test, full suite passing",
      "files": [
        "test-driven-development"
      ],
      "expectations": [
        "A test reproducing the lost-cent case from BUG.md is added and shown failing before src/split.js is modified",
        "The final implementation satisfies the full README fairness invariant (leftover cents go to the earliest shares): splitCents(10000, 3) returns [3334, 3333, 3333] as BUG.md expects and splitCents(100, 7) returns [15, 15, 14, 14, 14, 14, 14] as the README example shows; dumping the whole remainder on a single share would violate both",
        "The fairness invariant from the README has its own test case in the suite on an input with remainder of at least 2 (such as splitCents(100, 7)), where dumping the whole remainder on one share would fail it, beyond the reported lost-cent case",
        "The full suite is run with the repository's own command after the fix"
      ]
    }
  ]
}
```

- `evals[]` uses skill-creator's core schema (`id`, `prompt`, `expected_output`, optional `files[]`, `expectations[]`) plus this repository's optional `kind`. `kind` must be `execution` or `dialogue` and defaults to `execution` for compatibility. Execution evals require non-empty `files[]`; paths are relative to `evals/fixtures/` and may name a file or project directory. Dialogue evals may omit `files[]` because the transcript is the artifact. Expectations are verifiable statements a grader checks against the relevant artifact — behaviors, not phrasings.
- `trigger` is this repo's extension. `positive` prompts are realistic user asks that should route here (`top_k` defaults to 3 and must be a positive safe integer; tighten to 1 for a skill's signature ask). `negative` prompts belong to a *different* skill; this skill must not rank first for them. Declare that skill in `owner` where you can: it must be a nonempty skill identifier, and its score must be **strictly greater** than this skill's score. Equal scores do not pass because of sort order; prompts that match nothing do not pass vacuously.

**Writing good trigger prompts:** paraphrase how users actually talk; don't copy the description (that's gaming the eval). If a realistic prompt can't rank because the description lacks its vocabulary, that is a real finding — improve the description.

## Adding a skill

Every skill ships with an eval file. When you add `skills/<name>/`, add `evals/cases/<name>.json` with at least 3 positive triggers, 2 negative triggers, and 1 behavioral eval. Execution evals must be backed by `evals/fixtures/<name>/`; use `kind: "dialogue"` only when the skill's deliverable is genuinely the conversation itself. Missing case files, incomplete case counts, unknown kinds, invalid fixture paths, and absent required fixtures are CI errors.

## Metrics to watch

The Tier-2 run prints a **trigger rank-1 rate** (share of positive prompts that rank their skill first, not merely top-k). CI runs with `--min-rank1 95`, leaving useful headroom below the checked-in 100% baseline so an unrelated description edit does not immediately turn CI red. Raise the floor as routing improves; never lower it to make a regression pass. Falling numbers mean descriptions are drifting toward each other. The collision check errors at ≥75% pairwise description similarity and warns at ≥50%. When these evals surface a description-vocabulary gap (see [#351](https://github.com/addyosmani/agent-skills/issues/351) for the original examples), fix the description, not the prompt.
