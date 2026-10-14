# ON-B-02 review

## Overview
PR #1055 adds an optional setup transition and native-permission adapter. The reviewed source is a6a6e6d23c00449f39aee9e85a4cc2480d911b7e against 5024ea7455a5613be0514475be32c0dee6de0edd; all ten source/docs files and relevant existing setup, settings, hosted guards, permission and startup services were inspected. No sibling module, shared registration or UI file is changed. This is a direct implementer review using the pr-reviewer skill, not an independent agent review. Full CI was pending at this receipt snapshot; the final exact-head result belongs to the PR handoff.

## What's good
- Hosted provider credentials stay server-owned; unknown and unavailable hosted states never become self-hosted setup.
- Durable setup completion is separate from verified runtime readiness. Failed and lost responses can be retried.
- First setup writes Awareness off before completion; reads and native permission checks never enable it.
- Existing settings and native permission services are reused, with real persistence failure tests.

## Issues
None remaining. During implementation review, a device-affinity race was found: a fallback desktop could change after a permission read, opening Settings on another machine. The adapter now checks and pins the original target at `src/onboarding-next/setup/daemon-adapter.ts:112`; the checked grant is also tied to the final read's host. The regression fails when that guard is removed and passes when restored.

## Blocking vs. non-blocking
- Blocking code findings: none.
- Merge gate: full GitHub CI must pass on the final pushed head.
- Activation gates: ON-B-11/ON-U-10 assembly, actual service readiness integration, D/F/Q candidate and real hosted/device validation remain outstanding. They are explicit release gates, not sibling merge dependencies.

## Test coverage assessment
**Adequate with gaps.** Executed 43 module tests and 157 focused regressions, typecheck, UI/workflow builds, four guards and normal hooks. The isolated candidate passed absent, standalone, combined and setup-removed tests/typecheck/build, with identical ON-B-02 source bytes. SQLite and canonical persistence are real; runtime startup, OS replies and synthetic assembly are controlled fixtures. Actual providers, devices, capture and deployment were not exercised.

## Final recommendation
**Approve with comments** for the independent, unregistered module once final CI passes; live activation remains blocked by the documented integration and device evidence gates.
