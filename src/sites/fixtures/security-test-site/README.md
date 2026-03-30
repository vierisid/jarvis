# Security Test Site (Fixture)

Browser-based attack suite for the site builder proxy. Tests iframe sandbox,
same-origin isolation, WebSocket origin checks, and capability restrictions.

## Usage

Copy to the Jarvis projects directory, install, and open in the Sites page:

```sh
cp -r src/sites/fixtures/security-test-site ~/.jarvis/projects/security-test
cd ~/.jarvis/projects/security-test
bun install
git init && git add -A && git commit -m "init"
```

Then open the Jarvis dashboard, go to Sites, and start the `security-test` project.
All 28 tests should show **BLOCKED**.
