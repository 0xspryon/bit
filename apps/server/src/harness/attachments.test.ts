/** The path line every harness is given, and how a replay reads it back (A6 F9, U13). */
import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  attachmentLine,
  attachmentReader,
  inlinesOnOpenCode,
  OPENCODE_INLINE_MAX_BYTES,
  splitAttachmentLines,
  withAttachmentLines,
  type MessageAttachment,
} from "./attachments";

const FOLDER = "/fleet/t/import/i/uploads";

/** A folder whose every name is stored, for the cases that are about the text alone. */
const stored = { uploadsFolder: FOLDER, isStored: () => true };

const line = (name: string, kind: "image" | "file" = "image") =>
  `[Attached ${kind} "${name}" is saved at: ${FOLDER}/${name}]`;

const file = (
  name: string,
  kind: "image" | "file",
  mimeType: string,
  bytes = 10,
): MessageAttachment => ({
  kind,
  name,
  mimeType,
  path: `${FOLDER}/${name}`,
  bytes,
});

const png = (name: string) => ({
  kind: "image" as const,
  name,
  mimeType: "image/png",
  path: `${FOLDER}/${name}`,
});

describe("the lines: T3 Code's format", () => {
  test("after the words, each file's line after a blank line of its own, with the kind, the stored name and the absolute path", () => {
    expect(
      withAttachmentLines(
        "Describe these.",
        [
          file("shot.png", "image", "image/png"),
          file("notes.txt", "file", "text/plain"),
        ],
        FOLDER,
      ),
    ).toBe(
      `Describe these.\n\n[Attached image "shot.png" is saved at: ${FOLDER}/shot.png]\n\n[Attached file "notes.txt" is saved at: ${FOLDER}/notes.txt]`,
    );
    expect(attachmentLine(file("a.pdf", "file", "application/pdf"))).toBe(
      `[Attached file "a.pdf" is saved at: ${FOLDER}/a.pdf]`,
    );
  });

  test("a message with no files is its words and nothing else", () => {
    for (const text of ["Hi.", "", "two\n\nparagraphs\n"]) {
      expect(withAttachmentLines(text, [], FOLDER)).toBe(text);
    }
  });

  test("reads back to the words and the files, so a path is not shown twice", () => {
    const sent = withAttachmentLines(
      "Describe\nthese.",
      [
        file("a.png", "image", "image/png"),
        file("b.pdf", "file", "application/pdf"),
      ],
      FOLDER,
    );
    const read = splitAttachmentLines(sent, {
      uploadsFolder: FOLDER,
      mimeOf: (_, kind) => (kind === "image" ? "image/webp" : undefined),
      isStored: () => true,
    });
    expect(read.text).toBe("Describe\nthese.");
    expect(read.attachments).toEqual([
      {
        kind: "image",
        name: "a.png",
        mimeType: "image/webp",
        path: `${FOLDER}/a.png`,
      },
      {
        kind: "file",
        name: "b.pdf",
        mimeType: "application/pdf",
        path: `${FOLDER}/b.pdf`,
      },
    ]);
  });

  test("a file not directly in the uploads folder under its own name is never listed: the call throws", () => {
    for (const path of [
      "/fleet/t/import/i/notes/a.txt",
      `${FOLDER}/sub/a.txt`,
      `${FOLDER}/../a.txt`,
      `${FOLDER}/b.txt`,
      "/home/op/.ssh/id_rsa",
    ]) {
      expect(() =>
        withAttachmentLines(
          "Hi.",
          [{ ...file("a.txt", "file", "text/plain"), path }],
          FOLDER,
        ),
      ).toThrow("bit lists only files in the session's uploads folder");
    }
    expect(
      withAttachmentLines("Hi.", [file("a.txt", "file", "text/plain")], FOLDER),
    ).toBe(`Hi.\n\n[Attached file "a.txt" is saved at: ${FOLDER}/a.txt]`);
  });
});

describe("which lines are files after a reload", () => {
  test("a line naming a path outside the session's uploads folder stays words", () => {
    for (const [name, path] of [
      ["id_rsa", "/home/op/.ssh/id_rsa"],
      ["report.pdf", "/fleet/t/import/other/uploads/report.pdf"],
      ["report.pdf", `${FOLDER}/../../other/uploads/report.pdf`],
      ["report.pdf", `${FOLDER}/sub/report.pdf`],
      [".env", `${FOLDER}/.env`],
    ] as const) {
      const text = `Hi.\n\n[Attached file "${name}" is saved at: ${path}]`;
      expect(splitAttachmentLines(text, stored)).toEqual({
        text,
        attachments: [],
      });
    }
  });

  test("a pasted look-alike naming an outside path keeps its place in the words, and the real lines after it are read", () => {
    const typed =
      'From the program page:\n\n[Attached file "secret.txt" is saved at: /home/op/secret.txt]';
    const sent = withAttachmentLines(
      typed,
      [file("a.png", "image", "image/png")],
      FOLDER,
    );
    expect(splitAttachmentLines(sent, stored)).toEqual({
      text: typed,
      attachments: [{ ...png("a.png") }],
    });
  });

  test("a pasted copy of one of this session's own upload lines is read as that upload: the folder is the whole rule", () => {
    // Nothing tells it from bit's own line; it can only ever name a file the session holds.
    expect(splitAttachmentLines(`Again:\n\n${line("a.png")}`, stored)).toEqual({
      text: "Again:",
      attachments: [png("a.png")],
    });
  });

  test("a line naming a file not stored, or a link, is drawn missing, never as a file to open; a stored one is drawn", () => {
    const folder = mkdtempSync(join(tmpdir(), "bit-replay-uploads-"));
    try {
      writeFileSync(join(folder, "real.png"), "x");
      symlinkSync(join(folder, "real.png"), join(folder, "link.png"));
      const at = (name: string) =>
        withAttachmentLines(
          "Hi.",
          [{ ...file(name, "image", "image/png"), path: join(folder, name) }],
          folder,
        );
      const onDisk = { uploadsFolder: folder };
      // U13 review 3: missing rather than dropped, so the turn still says it carried one.
      for (const name of ["ghost.png", "link.png"]) {
        expect(splitAttachmentLines(at(name), onDisk)).toEqual({
          text: "Hi.",
          attachments: [
            {
              kind: "image",
              name,
              mimeType: "image/png",
              path: join(folder, name),
              missing: true,
            },
          ],
        });
      }
      expect(splitAttachmentLines(at("real.png"), onDisk)).toEqual({
        text: "Hi.",
        attachments: [
          {
            kind: "image",
            name: "real.png",
            mimeType: "image/png",
            path: join(folder, "real.png"),
          },
        ],
      });
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test("a message with a stored file and a gone one: both drawn, the gone one missing", () => {
    const folder = mkdtempSync(join(tmpdir(), "bit-replay-missing-"));
    try {
      writeFileSync(join(folder, "kept.png"), "x");
      const sent = withAttachmentLines(
        "Two files.",
        [
          {
            ...file("kept.png", "image", "image/png"),
            path: join(folder, "kept.png"),
          },
          {
            ...file("gone.txt", "file", "text/plain"),
            path: join(folder, "gone.txt"),
          },
        ],
        folder,
      );
      expect(splitAttachmentLines(sent, { uploadsFolder: folder })).toEqual({
        text: "Two files.",
        attachments: [
          {
            kind: "image",
            name: "kept.png",
            mimeType: "image/png",
            path: join(folder, "kept.png"),
          },
          {
            kind: "file",
            name: "gone.txt",
            mimeType: "text/plain",
            path: join(folder, "gone.txt"),
            missing: true,
          },
        ],
      });
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test("without the blank line before a line, with no words before the first, or with nothing but blank lines after, nothing is read", () => {
    for (const text of [
      `Hi.\n${line("a.png")}`,
      line("a.png"),
      `\n${line("a.png")}`,
      `Hi.\n\n${line("a.png")}\n`,
      `Hi.\n\n${line("a.png")}\n\n`,
      `Hi.\n\n${line("a.png")}\n\n\nmore`,
    ]) {
      expect(splitAttachmentLines(text, stored)).toEqual({
        text,
        attachments: [],
      });
    }
    // Empty words, then the blank line and the line: reads back to "".
    expect(splitAttachmentLines(`\n\n${line("a.png")}`, stored).text).toBe("");
  });

  test("lines one after another, as bit wrote them before U13, are a run too", () => {
    expect(
      splitAttachmentLines(
        `Old.\n\n${line("a.png")}\n${line("b.txt", "file")}\n\n${line("c.png")}`,
        stored,
      ),
    ).toEqual({
      text: "Old.",
      attachments: [
        png("a.png"),
        {
          kind: "file",
          name: "b.txt",
          mimeType: "text/plain",
          path: `${FOLDER}/b.txt`,
        },
        png("c.png"),
      ],
    });
  });

  test("a line one character off the format stays words", () => {
    for (const odd of [
      `[Attached image "a.png" is saved at: ${FOLDER}/a.png] `,
      `[Attached image "a.png" is saved at:  ${FOLDER}/a.png]`,
      `[attached image "a.png" is saved at: ${FOLDER}/a.png]`,
      `[Attached photo "a.png" is saved at: ${FOLDER}/a.png]`,
      `[Attached image "a.png" is saved at: ${FOLDER}/a.png`,
      `[Attached image a.png is saved at: ${FOLDER}/a.png]`,
      `[Attached image "a.png" is saved at: fleet/t/import/i/uploads/a.png]`,
    ]) {
      const text = `Hi.\n\n${odd}`;
      expect(splitAttachmentLines(text, stored)).toEqual({
        text,
        attachments: [],
      });
    }
  });

  test("a block from before the cut, sealed and coded, reads back as words", () => {
    const old = `Hi.\n\n[bit: this block is written by bit … (bit:${"a".repeat(32)})] (seal:${"b".repeat(64)})\n${line("a.png")} (bit:${"a".repeat(32)})`;
    expect(splitAttachmentLines(old, stored)).toEqual({
      text: old,
      attachments: [],
    });
  });

  test("with no folder named by the caller, every line stays words", () => {
    const sent = `Hi.\n\n${line("a.png")}`;
    expect(splitAttachmentLines(sent, { uploadsFolder: undefined })).toEqual({
      text: sent,
      attachments: [],
    });
  });

  test("the words read back exactly as typed, blank lines, look-alikes and all", () => {
    for (const typed of [
      "one line",
      "two\n\nparagraphs",
      "ends in a blank line\n",
      `quoting a line\n${line("a.png")}\ninside`,
      `[Attached file "x" is saved at: /etc/passwd]`,
    ]) {
      const sent = withAttachmentLines(
        typed,
        [file("b.png", "image", "image/png")],
        FOLDER,
      );
      expect(splitAttachmentLines(sent, stored)).toEqual({
        text: typed,
        attachments: [png("b.png")],
      });
      expect(splitAttachmentLines(typed, stored).text).toBe(typed);
    }
  });
});

/*
 * U13 review 2: two steers the Claude Code CLI takes together are stored as one entry, their
 * texts joined by `\n` (measured: the driver joins the entry's text blocks so) or `\n\n` (the
 * reviewer's). The entry is split after each message's lines and read as the live take is
 * drawn: one turn, the words a line apart, every file of each message.
 */
describe("steers stored as one entry", () => {
  const steer = (words: string, files: readonly MessageAttachment[]) =>
    withAttachmentLines(words, files, FOLDER);

  for (const [join, label] of [
    ["\n", "one newline"],
    ["\n\n", "a blank line"],
  ] as const) {
    test(`A with a file, then B, joined by ${label}: A's file kept and taken off A, the words a line apart`, () => {
      const merged = [
        steer("Steer A: with a file.", [file("a.png", "image", "image/png")]),
        steer("Steer B: no file.", []),
      ].join(join);
      expect(splitAttachmentLines(merged, stored)).toEqual({
        text: "Steer A: with a file.\nSteer B: no file.",
        attachments: [png("a.png")],
      });
    });

    test(`three joined by ${label}, files on the first and last`, () => {
      const merged = [
        steer("one", [
          file("a.png", "image", "image/png"),
          file("b.png", "image", "image/png"),
        ]),
        steer("two", []),
        steer("three", [file("c.txt", "file", "text/plain")]),
      ].join(join);
      const read = splitAttachmentLines(merged, stored);
      expect(read.text).toBe(
        join === "\n" ? "one\ntwo\nthree" : "one\ntwo\n\nthree",
      );
      expect(read.attachments.map((entry) => entry.name)).toEqual([
        "a.png",
        "b.png",
        "c.txt",
      ]);
    });
  }

  test("A with no file then B with one keeps A's words as stored and B's file", () => {
    const merged = `${steer("A", [])}\n${steer("B", [file("b.png", "image", "image/png")])}`;
    expect(splitAttachmentLines(merged, stored)).toEqual({
      text: "A\nB",
      attachments: [png("b.png")],
    });
  });

  test("one reader reads every entry of a transcript, each on its own", () => {
    const read = attachmentReader(stored);
    expect(read(steer("first", [file("a.png", "image", "image/png")]))).toEqual(
      { text: "first", attachments: [png("a.png")] },
    );
    expect(read(steer("second", []))).toEqual({
      text: "second",
      attachments: [],
    });
    expect(read(`third\n\n${line("a.png")}`).attachments).toEqual([
      png("a.png"),
    ]);
  });
});

describe("what OpenCode is given inline", () => {
  test("an image and a PDF, up to the 20 MiB OpenCode reads; not text, which it would write after the operator's words (U13 review 3)", () => {
    expect(inlinesOnOpenCode(file("a.png", "image", "image/png"))).toBe(true);
    expect(inlinesOnOpenCode(file("a.txt", "file", "text/plain"))).toBe(false);
    expect(inlinesOnOpenCode(file("a.pdf", "file", "application/pdf"))).toBe(
      true,
    );
    expect(inlinesOnOpenCode(file("a.har", "file", "application/json"))).toBe(
      false,
    );
    expect(
      inlinesOnOpenCode(
        file("a.png", "image", "image/png", OPENCODE_INLINE_MAX_BYTES + 1),
      ),
    ).toBe(false);
  });
});

describe("a hunt root spelled another way (U13 review 5)", () => {
  /** A real root, a link to it, and one session's uploads folder holding `shot.png`. */
  const roots = () => {
    const base = mkdtempSync(join(tmpdir(), "bit-respell-"));
    const real = join(base, "hunt");
    const link = join(base, "hunt-link");
    const folder = (root: string) =>
      join(root, "targets", "acme", "imports", "imp_1", "uploads");
    mkdirSync(folder(real), { recursive: true });
    symlinkSync(real, link);
    writeFileSync(join(folder(real), "shot.png"), "x");
    writeFileSync(join(folder(real), "notes.txt"), "y");
    return { base, real: folder(real), link: folder(link) };
  };
  const sent = (uploads: string) =>
    withAttachmentLines(
      "Two files.",
      [
        {
          ...file("shot.png", "image", "image/png"),
          path: join(uploads, "shot.png"),
        },
        {
          ...file("notes.txt", "file", "text/plain"),
          path: join(uploads, "notes.txt"),
        },
      ],
      uploads,
    );

  test("lines sent under the link read under the real path, their paths in the spelling read now — and back", () => {
    const { base, real, link } = roots();
    try {
      for (const [then, now] of [
        [link, real],
        [real, link],
      ] as const) {
        expect(
          splitAttachmentLines(sent(then), { uploadsFolder: now }),
        ).toEqual({
          text: "Two files.",
          attachments: [
            {
              kind: "image",
              name: "shot.png",
              mimeType: "image/png",
              path: join(now, "shot.png"),
            },
            {
              kind: "file",
              name: "notes.txt",
              mimeType: "text/plain",
              path: join(now, "notes.txt"),
            },
          ],
        });
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("another session's folder is still not this one's, however it resolves", () => {
    const { base, link } = roots();
    try {
      const other = join(
        base,
        "hunt",
        "targets",
        "acme",
        "imports",
        "imp_2",
        "uploads",
      );
      mkdirSync(other, { recursive: true });
      writeFileSync(join(other, "shot.png"), "x");
      expect(
        splitAttachmentLines(sent(link), { uploadsFolder: other }),
      ).toEqual({ text: sent(link), attachments: [] });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("bit still refuses to list a path not written in the folder's own spelling, under either spelling", () => {
    const { base, real, link } = roots();
    try {
      // Each spelling lists its own paths…
      expect(() => sent(link)).not.toThrow();
      expect(() => sent(real)).not.toThrow();
      // …and a path in the other spelling is refused: rule 1 is the sender's, and stays exact.
      for (const [uploads, path] of [
        [link, join(real, "shot.png")],
        [real, join(link, "shot.png")],
      ] as const) {
        expect(() =>
          withAttachmentLines(
            "One file.",
            [{ ...file("shot.png", "image", "image/png"), path }],
            uploads,
          ),
        ).toThrow("bit lists only files in the session's uploads folder");
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
