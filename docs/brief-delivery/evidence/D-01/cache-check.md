# D-01 CI follow-up: release cache check

The original Docker image built and passed its smoke check, but the version-only cache assertion failed in [job 111778613608](https://github.com/vierisid/jarvis/actions/runs/37314770188/job/111778613608). This was not a failing Brief runtime test.

## Reproduction

A small Docker fixture reused the repository's exact `manifest` stage, then copied its normalized package.json into a second stage and ran `sha256sum` and `stat`. The check used a separate local Docker daemon and docker-container builders with BuildKit v0.33.1, matching the failing CI builder.

1. Build two package versions locally and export a mode=max cache.
2. Import that cache on a fresh builder and build the same version.
3. Change only the source package version. The cross-stage COPY and dependent RUN execute, although the normalized package has the same SHA-256 and mode/owner/size.
4. Change the source version once more. Both protected vertices report CACHED.

The normalized SHA-256 in these comparisons was `199c4550f1b1b9c027e404afc70e11ff8691b92b243040b6958a9b535fb2bcc8`; metadata was mode 644, uid/gid 0/0, 3997 bytes. Merely switching to COPY --link or writing the normalized manifest to a fresh path did not avoid the first rebuild after import.

## Correction

The warm-up now changes **both** package.json and VERSION to a unique warm version before the measured release version. Previously it changed only VERSION and could reuse the imported manifest result. All second-build assertions remain intact: dependencies, UI/model build, workflow builds and pre-stamp production steps must be cached; the stamp must run; missing required vertices fail closed.

This establishes the locally warmed baseline the script intends. It does not claim that remote cache export/import always preserves cross-stage reuse. That separate performance limitation remains observable; the Dockerfile and shipping image are unchanged.

## Local evidence

- Before the fix, the new regression suite reported 13 pass / 1 fail: the warm build still read the original source version `1.2.3`.
- After the fix, 14 tests pass with 86 assertions. They execute the actual shell script with controlled Docker logs and a narrow jq stand-in. They cover both manifest versions, unchanged caller files, platform-prefixed logs, missing stages/stamp, unexpected rebuilds and build errors. The real Docker CI job uses real jq and BuildKit.
- The imported-cache fixture's fresh warm-up reran COPY/RUN; its subsequent release build reported both CACHED. This is a small real-Docker reproduction, not a substitute for the full-image CI run.
- Combined cache-check, Brief and onboarding run: 49 tests / 409 assertions pass. Workflow hardening: 25 pass. Shell syntax: pass.

Check the PR's latest Docker check for the full-image verdict on its current head. Old failed runs remain visible as history.
