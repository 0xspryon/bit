/**
 * The files a composer holds before they are sent (A6 U13): what paste, drop and the `+`
 * picker put in, what the tray draws, and what the next message carries.
 *
 * ## One intake for three ways in
 *
 * Paste ({@link filesOfPaste}), drop ({@link filesOfDrop}) and the picker all hand `File`s to
 * {@link ComposerFiles.add}, so the three cannot disagree about what is refused. The bytes
 * stay in the browser until Send, and go in the message's own request (`client.ts`): there
 * is no upload step and nothing on the server until then (S8).
 *
 * ## What is refused here, and what is left to the server
 *
 * Refused at intake, through the F2 dialog: a **HEIC/HEIF** image and an **empty** file — a
 * rule the server holds too and that no setting changes, so saying it as the file goes in
 * spares a send that could only be refused. Every **figure** — 10 MiB an image, 50 MiB a
 * file, 100 files, the total — is the server's alone, because an operator can raise each
 * from the environment and this tab is not told: a send over one is refused by the server,
 * naming the figure, through the same dialog.
 *
 * And at Send, by the composer: files with **no words**. A file is evidence; what the agent
 * is to do with it is the message.
 */
import type { ErrorNotice } from "./components/ErrorDialog.svelte";

/** The image types a model sees as an image (`MESSAGE_IMAGE_MIME_TYPES`): thumbnailed. */
const THUMBNAIL_TYPES: ReadonlySet<string> = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

/** HEIC/HEIF, by type or — for a browser that sends none — by extension. */
const isHeic = (file: File): boolean =>
  /^image\/hei[cf](-sequence)?$/u.test(file.type.toLowerCase()) ||
  /\.(heic|heif)$/iu.test(file.name);

/** One file the composer holds. */
export interface ComposerFile {
  /** This tab's own key for it: two files may share a name. */
  readonly id: string;
  readonly file: File;
  /** An object URL for its thumbnail, on an image the model will see as one. */
  readonly preview: string | undefined;
}

/** "2.4 MiB", "830 KiB", "12 bytes": a size as the tray shows it. */
export const sizeLabel = (bytes: number): string => {
  if (bytes < 1024) return `${String(bytes)} ${bytes === 1 ? "byte" : "bytes"}`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
};

/** The sentence for files sent with no words (A6 U13). */
export const FILES_WITHOUT_WORDS: ErrorNotice = {
  title: "Message not sent",
  sentence:
    "A message with files needs words too: say what the agent is to do with them — what they are, and what to look for. Nothing was sent; the files are still attached.",
};

/** The files a composer holds, and the refusal of the last that could not be added. */
export class ComposerFiles {
  items = $state<readonly ComposerFile[]>([]);
  /** Why the last files could not be added, for the F2 dialog; `undefined` when none. */
  refusal = $state<ErrorNotice | undefined>(undefined);
  #next = 0;

  /**
   * Adds files, refusing a HEIC/HEIF image and an empty one with the reason. The rest are
   * added even when some are refused: each file stands or falls on its own here.
   */
  add(files: Iterable<File>): void {
    const added: ComposerFile[] = [];
    const refused: string[] = [];
    for (const file of files) {
      if (isHeic(file)) {
        refused.push(
          `'${file.name}' is a HEIC/HEIF image. bit does not convert images, and the models take GIF, JPEG, PNG and WebP only. Export it as JPEG or PNG and attach that.`,
        );
        continue;
      }
      if (file.size === 0) {
        refused.push(
          `'${file.name}' is empty. An agent told to read a file with nothing in it would report that the evidence says nothing, so it is not attached; attach it again once it has its contents.`,
        );
        continue;
      }
      this.#next += 1;
      added.push({
        id: `file-${String(this.#next)}`,
        file,
        preview:
          THUMBNAIL_TYPES.has(file.type.toLowerCase()) &&
          typeof URL.createObjectURL === "function"
            ? URL.createObjectURL(file)
            : undefined,
      });
    }
    if (added.length > 0) this.items = [...this.items, ...added];
    if (refused.length > 0) {
      this.refusal = {
        title:
          refused.length === 1 ? "File not attached" : "Files not attached",
        sentence: refused.join(" "),
      };
    }
  }

  /** Takes one file out, and lets its thumbnail go. */
  remove(id: string): void {
    const gone = this.items.find((item) => item.id === id);
    if (gone === undefined) return;
    revoke(gone);
    this.items = this.items.filter((item) => item.id !== id);
  }

  /** Takes out the files a message carried once the server has them. */
  drop(ids: readonly string[]): void {
    const gone = new Set(ids);
    for (const item of this.items) if (gone.has(item.id)) revoke(item);
    this.items = this.items.filter((item) => !gone.has(item.id));
  }

  /** The files, in the order they were added, for the message's request. */
  get files(): readonly File[] {
    return this.items.map((item) => item.file);
  }

  /** Empties the composer of files: sent, or the page left. */
  clear(): void {
    for (const item of this.items) revoke(item);
    this.items = [];
  }

  /** Says a refusal through the same dialog as the intake's (a send's, say). */
  refuse(notice: ErrorNotice): void {
    this.refusal = notice;
  }

  dismiss(): void {
    this.refusal = undefined;
  }
}

const revoke = (item: ComposerFile): void => {
  if (item.preview !== undefined && typeof URL.revokeObjectURL === "function") {
    URL.revokeObjectURL(item.preview);
  }
};

/**
 * The files a paste carries, or none: a paste that carries text as well is a paste of the
 * text (copying from a page or a spreadsheet often brings a picture of it along), so only
 * a paste of files alone attaches them — a screenshot, and a file copied in a file manager
 * that puts only the file on the clipboard. Some file managers also put the file's name
 * (or its path) there as text, and a paste of what they copied is then a paste of the name.
 *
 * V2(chat): a file copied in such a file manager cannot be pasted in; it has to be dropped
 * or picked with `+`. Proper V2: attach the files when the text is no more than their
 * names or `file://` URIs, and paste the text otherwise.
 */
export const filesOfPaste = (event: ClipboardEvent): readonly File[] => {
  const data = event.clipboardData;
  if (data === null) return [];
  if (data.types.includes("text/plain")) return [];
  return [...data.files];
};

/** Whether a drag carries files, so the composer can take the drop. */
export const dragHasFiles = (event: DragEvent): boolean =>
  event.dataTransfer?.types.includes("Files") ?? false;

/**
 * A chat panel's handlers for a drag of files anywhere over it (U13 review 1): a drop
 * just outside the composer's box used to be the browser's own, which opens the file in a
 * `file://` tab and leaves the app. Every file drag over the panel is the panel's: taken
 * into the tray when `accepting()`, refused with the no-drop cursor otherwise — and never
 * the browser's. `dropping` says whether one is over the panel now, for the box to light
 * up.
 */
export const panelFileDrop = (options: {
  readonly accepting: () => boolean;
  readonly take: (files: readonly File[]) => void;
  readonly dropping: (over: boolean) => void;
}) => ({
  ondragover: (event: DragEvent): void => {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    const accepting = options.accepting();
    if (event.dataTransfer !== null) {
      event.dataTransfer.dropEffect = accepting ? "copy" : "none";
    }
    options.dropping(accepting);
  },
  ondragleave: (event: DragEvent): void => {
    const next = event.relatedTarget;
    const panel = event.currentTarget;
    if (!(
      next instanceof Node &&
      panel instanceof Node &&
      panel.contains(next)
    )) {
      options.dropping(false);
    }
  },
  ondrop: (event: DragEvent): void => {
    options.dropping(false);
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    if (options.accepting()) options.take(filesOfDrop(event));
  },
});

/** The files a drop carries. */
export const filesOfDrop = (event: DragEvent): readonly File[] => [
  ...(event.dataTransfer?.files ?? []),
];
