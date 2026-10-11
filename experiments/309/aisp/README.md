# AISP pilot collection

This isolated collection contains one experiment for [issue #309](https://github.com/addyosmani/agent-skills/issues/309). The authored source is [spec_driven_development_aisp/aisp.aisop.json](spec_driven_development_aisp/aisp.aisop.json), an AISP V1.0.0 package over an AISOP V1.0.0 program. It preserves the existing `spec-driven-development` workflow while making its declared graph and approval bindings inspectable.

The native package id equals its folder name and ends in `_aisp`. Generated per-skill README and thin `SKILL.md` sidecars are projections, rather than independently authored workflow definitions. The installed `skills/` catalog continues to use the existing Markdown skill; this collection is outside that catalog.

There is no discovery script or index cache for this one-package pilot. Inspect the fixed native program directly, or discover it with `*_aisp/aisp.aisop.json`; AISP collection indexes and discovery scripts are recommended ecosystem artifacts, not prerequisites for the core package checks.

The experiment declares filesystem, shell, and skill-loading capabilities. It declares no colocated resources. Existing repository skills are named handoffs resolved by the host, not bundled native resources or an AISOP runtime dependency.

Static graph checks, source/projection checks, and AISP reference validation do not prove that a host obeys the approval gates. Generic Agent Skills hosts can follow the declaration on a best-effort basis. Hard confirmation and assertion behavior requires a conforming AISP/AISOP runtime and trustworthy execution evidence. In particular, reject, modify, stale revisions, cross-module approvals, and the later-turn specification review must also be assessed behaviorally.

See the [experiment README](../README.md) for scope, validation commands, semantic mapping, and evidence limits. The pilot retains this repository's MIT license.
