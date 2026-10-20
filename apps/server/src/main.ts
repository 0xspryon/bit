import { apiPath, type Health } from "@bit/contracts";
import { Effect } from "effect";

import { ObservationStore } from "./persistence/store";

/** Served under the one versioned prefix, like every endpoint this app owns. */
const HEALTH_PATH = apiPath("health");

const program = Effect.scoped(
  Effect.gen(function* () {
    // The store owns the connection for this scope and brings the schema up to date;
    // memory mode keeps the foundation side-effect-light when no path is configured.
    yield* ObservationStore;
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: Number(process.env.PORT ?? 3000),
          fetch(request) {
            if (new URL(request.url).pathname === HEALTH_PATH) {
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
  }).pipe(
    Effect.provide(
      ObservationStore.layer(process.env.DATABASE_PATH ?? ":memory:"),
    ),
  ),
);

await Effect.runPromise(program);
