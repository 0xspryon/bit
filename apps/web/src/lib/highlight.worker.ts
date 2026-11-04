/**
 * The highlighter's worker (A6 U11): tokenises one fence per message, off the page's
 * thread, and answers with the lines as data (`highlightEngine.ts`). Started by
 * `highlight.ts` the first time a closed fence in a known language is drawn.
 *
 * A request is `{ id, code, grammar }`. The worker answers `{ id, started: true }` once
 * Shiki and the grammar are loaded and tokenising begins, then `{ id, lines }`, or
 * `{ id, failed, retry }`. `retry` says whether a fresh worker might do better: a grammar
 * or the WASM that would not load might load next time, but a block that ran past its
 * budget would only run past it again. The grammar is checked again here, so a message
 * naming anything else loads nothing.
 */
import { tokenise, TokeniseOverBudget } from "./highlightEngine";
import { isGrammar } from "./highlightLanguages";

interface Request {
  readonly id: number;
  readonly code: string;
  readonly grammar: string;
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<Request>) => void) | null;
  postMessage: (message: unknown) => void;
};

scope.onmessage = (event) => {
  const { id, code, grammar } = event.data;
  if (!isGrammar(grammar)) {
    scope.postMessage({
      id,
      failed: "not a grammar this highlighter carries",
      retry: false,
    });
    return;
  }
  tokenise(code, grammar, {
    onStart: () => scope.postMessage({ id, started: true }),
  }).then(
    (lines) => scope.postMessage({ id, lines }),
    (error: unknown) =>
      scope.postMessage({
        id,
        failed: error instanceof Error ? error.message : "tokenising failed",
        retry: !(error instanceof TokeniseOverBudget),
      }),
  );
};
