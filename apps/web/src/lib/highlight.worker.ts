/**
 * The highlighter's worker (A6 U11): tokenises one fence per message, off the page's
 * thread, and answers with the lines as data (`highlightEngine.ts`). Started by
 * `highlight.ts` the first time a closed fence in a known language is drawn.
 *
 * A request is `{ id, code, grammar }`; the answer is `{ id, lines }` or `{ id, failed }`.
 * The grammar is checked again here, so a message naming anything else loads nothing.
 */
import { tokenise } from "./highlightEngine";
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
    scope.postMessage({ id, failed: "not a grammar this highlighter carries" });
    return;
  }
  tokenise(code, grammar).then(
    (lines) => scope.postMessage({ id, lines }),
    (error: unknown) =>
      scope.postMessage({
        id,
        failed: error instanceof Error ? error.message : "tokenising failed",
      }),
  );
};
