<!-- generated_from_aisp: true -->
<!-- source: aisp.aisop.json -->
<!-- generator: experiments/309/check.js -->
<!-- Generated locally from the canonical JSON. Do not edit. -->
# Spec-Driven Development Pilot

Creates a reviewed specification before planning, task breakdown, and incremental implementation.

Canonical source: [aisp.aisop.json](aisp.aisop.json). The adjacent [SKILL.md](SKILL.md) is a generated discovery bridge.

| Metadata | Value |
| --- | --- |
| ID | spec_driven_development_aisp |
| Protocol | AISP V1.0.0 |
| Version | 0.1.0 |
| License | MIT |
| Invocation | auto_or_manual |

Use when:
- starting a new project, feature, or significant change without a specification
- drafting a PRD or requirements document with objectives and scope
- clarifying ambiguous or incomplete requirements
- changing multiple files or modules or making an architectural decision
- implementing work expected to take more than 30 minutes
- decomposing a request spanning independently testable capabilities

Do not use when:
- single-line fixes or typo corrections
- changes whose requirements are unambiguous and self-contained

This package is an isolated authoring and static-validation experiment. The local checker does not execute the workflow, implement a runtime, prove human approval, or claim complete AISP conformance. Deterministic confirmation and assertions require an AISOP-compatible executor. Behavioral evals remain necessary.

Run from the repository root:

```sh
node experiments/309/check.js --check
node --test experiments/309/check-test.js
# Regenerate both Markdown projections after editing the canonical JSON:
node experiments/309/check.js --write
```
