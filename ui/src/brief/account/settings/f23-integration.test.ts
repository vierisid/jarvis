import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
// F-23 remains an unmerged sibling stack. The explicit proof runs in a child so
// its vault singleton and environment can never contaminate the D test process.
test.skipIf(!process.env.D30_F23_ROOT)(
  "D30 settings roundtrips through the pinned actual F23 routes and SQLite owner",
  async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(
          new URL("../../../../../scripts/check-d30-f23.ts", import.meta.url),
        ),
      ],
      { env: process.env, stdout: "pipe", stderr: "pipe" },
    );
    const [exit, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ exit, error }).toEqual({ exit: 0, error: "" });
    expect(output).toContain('"result": "pass"');
  },
  20000,
);
