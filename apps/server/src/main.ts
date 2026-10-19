import type { Health } from "@bit/contracts";
import { Effect } from "effect";
import { openDatabase } from "./persistence/database";

const program = Effect.scoped(
  Effect.gen(function* () {
    // No application schema yet; memory mode keeps the foundation side-effect-light.
    yield* openDatabase(process.env.DATABASE_PATH ?? ":memory:");
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: Number(process.env.PORT ?? 3000),
          fetch(request) {
            if (new URL(request.url).pathname === "/api/health") {
              return Response.json({ status: "ok" } satisfies Health);
            }
            return new Response("Not found", { status: 404 });
          },
        }),
      ),
      (server) => Effect.promise(() => server.stop(true)),
    );
    console.log(`bit server: ${server.url}`);
    yield* Effect.callback<void>((resume) => {
      const stop = () => resume(Effect.void);
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      return Effect.sync(() => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      });
    });
  }),
);

await Effect.runPromise(program);
