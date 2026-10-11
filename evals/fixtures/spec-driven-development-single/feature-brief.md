# Duration formatter — feature brief

Specify one capability: a pure `formatDuration(seconds)` helper that converts
an elapsed duration into `M:SS` text for an existing command-line report. The
report already supplies elapsed seconds; this request changes only the
formatter. There are no independently shippable modules to decompose.

## Objective and acceptance criteria

- Accept a non-negative safe integer number of seconds, including zero.
- Return total minutes without leading zeroes, followed by a colon and exactly
  two digits for the remaining seconds: `0` gives `0:00`, `5` gives `0:05`,
  `65` gives `1:05`, and `3600` gives `60:00`.
- Treat negative zero as zero. Never wrap minutes into hours.
- Throw `TypeError` for non-number inputs; do not coerce strings or null.
- Throw `RangeError` for negative, fractional, non-finite, or unsafe numbers.
- Keep the helper deterministic, with no filesystem, network, clock, or other
  side effects. The existing report consumes its returned string.

## Known project conventions

- Runtime: Node.js 24, plain JavaScript with CommonJS modules; no dependencies
  or transpilation are needed.
- Source target: `src/format-duration.js`, exporting `formatDuration` by name.
- Tests target: `test/format-duration.test.js`, using `node:test` and
  `node:assert/strict`.
- Spec target: `SPEC.md` at the project root. This project has no external spec
  system or task tracker.
- Test command: `node --test test/format-duration.test.js`.
- Full test command: `node --test`.
- Syntax check: `node --check src/format-duration.js`. There is no build step
  or separate lint tool in this plain-JavaScript project.
- Development test command: `node --watch --test test/format-duration.test.js`.
- Code style: two-space indentation, single quotes, semicolons, camelCase
  functions and variables, and named CommonJS exports such as
  `module.exports = { formatDuration };`. Follow the existing test style,
  for example `assert.equal(formatDuration(65), '1:05');`.
- Test the stated examples and invalid-input categories, including negative
  zero, NaN, infinity, fractional values, unsafe numbers, and non-number types.
  This pure helper needs unit tests; integration and end-to-end work is outside
  this request.

## Boundaries and non-goals

- Always: preserve this contract, validate inputs explicitly, and run the
  focused and full test commands before committing an implementation.
- Ask first: change the public contract, introduce dependencies, or modify
  project/CI configuration.
- Never: add silent coercion, change report callers, remove failing tests, or
  introduce filesystem/network side effects.
- Out of scope: billing, tax, invoicing, usage capture, account migration,
  persistence, report rendering, a new CLI, and localization. Those features
  are not needed to deliver this formatter and must not become extra modules.

## Non-blocking future question

Should a future request add localized duration text? Record this as a deferred
question outside the present `M:SS` contract; do not invent a localization
requirement or delay this specification for that future decision.

Produce and save the specification using the known scope above. Identify any
remaining assumptions or open questions, then request human approval. This
brief supplies requirements; it does not approve the resulting specification,
implementation plan, or implementation work.
