# ON-U-06 verification

Implementation: `b7dfe1df2b1560ee0245b708a13b5ef59294fed2`.
Base: `5024ea7455a5613be0514475be32c0dee6de0edd` (`main`).
Dedicated worktree: `/home/vierisid/.cache/codex/jarvis-on-u-06`.

## Design and scope

Read both onboarding execution contracts and ON-U-06 from the 14 October 2026
roadmaps. Inspected the live closed and open Figma tutorial states
`1097:42287` and `1097:44821`, version `2410205462365531104`.
No Figma, legacy onboarding, backend, registry or production entry edits.

The preview uses actual D-06 PebbleLayout/motion/controls/logo at
`f77b6e712f2e223ac2d781dbcf38f606c324ba03`, extracted into a temporary build cache.
The backdrop and conversation contents are explicit illustrative fixtures.
There is no chat send action. U-07 is represented by an intent receipt only.

## Executed checks

| Check | Observed result |
| --- | --- |
| `bun test ui/src/onboarding-next/views/pebble-tour ui/src/v2/onboarding` | 107 pass, 0 fail, 426 assertions; 20 new module cases |
| `bunx tsc --noEmit` | Pass |
| `bun run build:ui` with Bun on PATH | Pass; existing `@theme`/`@tailwind` warnings |
| Standalone preview build with pinned D-06 | Pass |
| Standalone preview build with `ON_U_06_MISSING_SHELL=1` | Pass; missing adapter rendered truthfully |
| Normal commit hooks | Pass: EE imports, migrations, 100 templates, package contents, 20 related tests, typecheck |
| Diff whitespace check | Pass |

The initial UI build command lacked Bun on PATH and stopped in `prebuild:ui`;
the environment was corrected and the unchanged command passed. Frozen install
ran the repository's normal Bun-install postinstall; no lockfile change resulted.

## Browser evidence

`browser-checks.json` records the observed DOM results:

- 24 combinations: 1440×1000, 768×900 and 390×844; Light/Dark;
  expanded/rail model; closed/open. No page horizontal overflow, no overlap
  between tutorial card and panel/opener, and primary action inside the viewport.
  At 390px the illustrative sidebar is hidden, so this does not certify the
  eventual narrow navigation implementation.
- Ten actual close/reopen cycles retained `Prepare my next call with Alex.` and
  selected object `sample-follow-up`; no message was submitted.
- Ten further open/close cycles after the compact CSS fix all returned to closed.
  These are repeated browser actions, not a timing-certified interruption test.
- Enter on Open Pebble focuses the existing D-line conversation draft; Escape
  returns to Open Pebble. Explicit reduced motion uses the D layout's immediate
  placement. Native OS motion preference and screen-reader output not certified.
- Dark tutorial and conversation both rendered `rgb(26, 29, 34)`.
- Missing adapter leaves Open Pebble unavailable; Back/Skip remain reachable.
  Skip emitted `skip → first-workflow`, not onboarding completion.
- The open-state primary emitted `next → first-workflow`. No workflow was created
  or executed, no OAuth was requested and no chat send path exists.

Screenshots: [wide Light/open](wide-light-open.png),
[narrow Dark/open](narrow-dark-open.png).

### Repair during verification

At 390px, the open-state wide width selector overrode the compact dock rule and
collapsed its width to zero. The compact selector now has matching specificity.
Retested all 24 combinations above on the corrected CSS; action and card are
visible, with the compact tutorial in a separate row below the conversation.

## Independent merge and removal

A temporary detached worktree combined the implementation with the exact sibling
heads listed in the receipt, without committing a merge or changing any PR.

- Combined tree: `266baa26c7f07e14fcd17a7ea48b95a1a6c8e17e`.
- UI plus legacy onboarding: 209 pass, 0 fail, 866 assertions.
- `bun test src/onboarding-next`: 243 pass, 0 fail, 1527 assertions. Bun's path
  filter also matches UI onboarding modules; this is not 243 backend-only tests.
- Combined TypeScript and production UI build: pass.
- Removed ON-U-06 tree: `4204c059f879f34cdbb5becc2c3dc367165fd69a`.
- Remaining UI plus legacy onboarding: 189 pass, 0 fail, 763 assertions.
- Removal TypeScript and production UI build: pass.
- Temporary merge aborted and temporary worktree removed. Delivery branch
  contains no sibling commits.

This proves module coexistence/removability and reuse of the pinned D layout in
the preview. It does not prove live B-06 tour persistence, U-10/B-11 discovery,
final D/F conversation composition, or the combined D/F/Q release candidate.

## Activation, rollback and quick verification

Unregistered and inactive. Activation requires ON-U-10, ON-B-06, ON-B-11 and the
verified Pebble host. Rollback disables the optional view before reverting its
owned files; keep journey data and the existing onboarding entry.

Open `http://127.0.0.1:4415/`. Press Open Pebble, type an unsent sample draft,
close/reopen, switch theme/sidebar, then choose Let’s build your first workflow.
Try Missing adapter and Reduce motion. The final page is a labeled handoff,
not an implemented U-07 prompt. No production account or workflow is mutated.
