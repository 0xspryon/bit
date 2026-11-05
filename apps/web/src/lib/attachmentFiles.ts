/**
 * How an attachment chip in an operator's turn gets the file it names (A6 U13).
 *
 * A turn's attachments carry a path and no bytes — live, from the server's answer; after a
 * reload, from the harness's transcript — so a chip asks the server for the stored file by
 * that path (`client.ts`'s `uploadedFile`, which the server re-derives and refuses outside a
 * session's own `uploads/` folder). The chat that draws the turns sets the loader in context
 * ({@link setAttachmentLoader}); `ChatItem` and the importer's bubble draw chips without
 * knowing which server or target they are on.
 */
import { getContext, setContext } from "svelte";

/** A stored file's bytes, or the sentence for why there are none. */
export type LoadedFile =
  | { readonly _tag: "file"; readonly bytes: Uint8Array }
  | { readonly _tag: "none"; readonly detail: string };

export type AttachmentLoader = (path: string) => Promise<LoadedFile>;

const KEY = Symbol("bit.attachmentLoader");

/** Called by a chat component, during its initialisation. */
export const setAttachmentLoader = (loader: AttachmentLoader): void => {
  setContext(KEY, loader);
};

/** The loader the enclosing chat set, or `undefined` (the state picker, a test). */
export const attachmentLoader = (): AttachmentLoader | undefined =>
  getContext<AttachmentLoader | undefined>(KEY);

/**
 * The type a blob of this attachment may be **opened** as in a tab, or `undefined` to
 * download it instead.
 *
 * A blob URL is this page's own origin, so a file opened as `text/html` (or SVG) would run
 * as bit itself — and an attachment is a file from somebody else's system. Only what a tab
 * shows inertly is opened: the four model image types, a PDF, and text, forced to
 * `text/plain` whatever its kind (a `.html` capture reads as its source). Everything else is
 * saved under its name.
 */
export const openableType = (mimeType: string): string | undefined => {
  const type = mimeType.toLowerCase();
  if (
    type === "image/gif" ||
    type === "image/jpeg" ||
    type === "image/png" ||
    type === "image/webp" ||
    type === "application/pdf"
  ) {
    return type;
  }
  if (
    type.startsWith("text/") ||
    type === "application/json" ||
    type === "application/xml"
  ) {
    return "text/plain;charset=utf-8";
  }
  return undefined;
};
