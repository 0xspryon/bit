/**
 * The process entrypoint for the spike demos.
 *
 * `@effect/platform-bun` — whose `BunRuntime.runMain` is the stock answer here — is not
 * a dependency of this workspace, so this is the same thing built from
 * `Runtime.makeRunMain`, which is the documented seam for exactly that
 * (`effect/src/Runtime.ts:183`, "Creates a platform-specific main program runner").
 *
 * What it buys over the `Effect.runSync(Scope.make())` / `Scope.close(..., Effect.void
 * as never)` pattern it replaces:
 *
 * - **No casts.** `Scope.close` wants an `Exit`; the old code passed `Effect.void` and
 *   silenced the type error with `as never`. (`Effect.void` *is* recognised as a success
 *   `Exit` at runtime in 4.0.5, so finalizers did still run — the bug was the lie to the
 *   compiler and the loss of the program's real exit, not a broken finalizer.)
 * - **The program's own exit survives.** A failure or interruption reaches the teardown
 *   and sets the process exit code, instead of being discarded by a `.finally`.
 * - **Signals interrupt rather than kill.** `SIGINT`/`SIGTERM` interrupt the main fiber,
 *   so scope finalizers — the harness process, the MCP endpoint, the live credentials —
 *   actually run on Ctrl-C.
 */
import { Effect, Fiber, Runtime } from "effect";

export const runMain = Runtime.makeRunMain(({ fiber, teardown }) => {
  const interrupt = () => {
    Effect.runFork(Fiber.interrupt(fiber));
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  fiber.addObserver((exit) => {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    teardown(exit, (code) => {
      process.exit(code);
    });
  });
});
