/**
 * The server refuses to start on an attachment key that is there and unusable (U13 review
 * 2, finding 4, the operator's decision). Round 1 ran on a temporary key instead, which hid
 * the broken setup until every file read back as words.
 *
 * Each case boots the real entrypoint against a fresh `HUNT_ROOT` and reads its exit: the
 * key is read while the module loads, before anything is served or spawned, so a refusal
 * exits in the time it takes to load the module.
 */
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ATTACHMENT_KEY_FILE } from "./harness/attachments";

const boot = async (
  root: string,
): Promise<{ readonly code: number; readonly stderr: string }> => {
  const child = Bun.spawn(["bun", join(import.meta.dir, "main.ts")], {
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: root,
      HUNT_ROOT: join(root, "hunt"),
      WORKSPACE_ROOT: root,
      PORT: "0",
      HARNESS: "0",
      BIT_PASSWORD: "test-password",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const killer = setTimeout(() => {
    child.kill();
  }, 30_000);
  const code = await child.exited;
  clearTimeout(killer);
  return { code, stderr: await new Response(child.stderr).text() };
};

const withRoot = async (
  body: (root: string, key: string) => Promise<void>,
): Promise<void> => {
  const root = mkdtempSync(join(tmpdir(), "bit-main-key-"));
  try {
    const hunt = join(root, "hunt");
    await Bun.write(join(hunt, ".keep"), "");
    await body(root, join(hunt, ATTACHMENT_KEY_FILE));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

describe("an unusable attachment key stops the server at boot", () => {
  test("a key others can read: exit 1, saying so and naming chmod 600, and the key is left as it was", async () => {
    await withRoot(async (root, key) => {
      const bytes = new Uint8Array(32).fill(9);
      writeFileSync(key, bytes);
      chmodSync(key, 0o644);
      const { code, stderr } = await boot(root);
      expect(code).toBe(1);
      expect(stderr).toContain("refusing to start");
      expect(stderr).toContain("can be read by others (mode 644)");
      expect(stderr).toContain(`chmod 600 '${key}'`);
      // Never replaced: a new key would turn every file sent so far into words.
      expect([...readFileSync(key)]).toEqual([...bytes]);
    });
  }, 60_000);

  test("a key of the wrong size, and a link to a good one, are refused the same way", async () => {
    await withRoot(async (root, key) => {
      writeFileSync(key, new Uint8Array(16), { mode: 0o600 });
      const short = await boot(root);
      expect(short.code).toBe(1);
      expect(short.stderr).toContain("is 16 bytes, and the key is exactly 32");
      rmSync(key);
      const real = join(root, "elsewhere.key");
      writeFileSync(real, new Uint8Array(32), { mode: 0o600 });
      symlinkSync(real, key);
      const linked = await boot(root);
      expect(linked.code).toBe(1);
      expect(linked.stderr).toContain("is a symbolic link");
    });
  }, 60_000);

  test("a missing key in a folder the server cannot write is refused too", async () => {
    await withRoot(async (root, key) => {
      const hunt = join(root, "hunt");
      chmodSync(hunt, 0o500);
      try {
        const { code, stderr } = await boot(root);
        expect(code).toBe(1);
        expect(stderr).toContain("is missing and could not be made");
        expect(existsSync(key)).toBe(false);
      } finally {
        chmodSync(hunt, 0o700);
      }
    });
  }, 60_000);
});
