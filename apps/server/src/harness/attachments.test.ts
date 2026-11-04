/** The path line every harness is given, and how a replay reads it back (A6 F9). */
import { describe, expect, test } from "bun:test";

import {
  attachmentLine,
  inlinesOnOpenCode,
  OPENCODE_INLINE_MAX_BYTES,
  splitAttachmentLines,
  withAttachmentLines,
  type MessageAttachment,
} from "./attachments";

const file = (
  name: string,
  kind: "image" | "file",
  mimeType: string,
  bytes = 10,
): MessageAttachment => ({
  kind,
  name,
  mimeType,
  path: `/fleet/t/import/i/uploads/${name}`,
  bytes,
});

describe("the path line", () => {
  test("names the kind, the stored name and the absolute path, one per file after a blank line", () => {
    expect(attachmentLine(file("shot.png", "image", "image/png"))).toBe(
      '[Attached image "shot.png" is saved at: /fleet/t/import/i/uploads/shot.png]',
    );
    expect(
      withAttachmentLines("Hi.", [
        file("a.png", "image", "image/png"),
        file("b.txt", "file", "text/plain"),
      ]),
    ).toBe(
      'Hi.\n\n[Attached image "a.png" is saved at: /fleet/t/import/i/uploads/a.png]\n[Attached file "b.txt" is saved at: /fleet/t/import/i/uploads/b.txt]',
    );
    expect(withAttachmentLines("Hi.", [])).toBe("Hi.");
  });

  test("reads back to the words and the files, so a path is not shown twice", () => {
    const sent = withAttachmentLines("Describe\nthese.", [
      file("a.png", "image", "image/png"),
      file("b.pdf", "file", "application/pdf"),
    ]);
    const read = splitAttachmentLines(sent, (_, kind) =>
      kind === "image" ? "image/webp" : undefined,
    );
    expect(read.text).toBe("Describe\nthese.");
    expect(read.attachments).toEqual([
      {
        kind: "image",
        name: "a.png",
        mimeType: "image/webp",
        path: "/fleet/t/import/i/uploads/a.png",
      },
      {
        kind: "file",
        name: "b.pdf",
        mimeType: "application/pdf",
        path: "/fleet/t/import/i/uploads/b.pdf",
      },
    ]);
  });

  test("only the trailing run is read: a line the operator typed mid-message stays their words", () => {
    const typed =
      '[Attached file "x.txt" is saved at: /etc/x.txt]\nwhat does that line mean?';
    expect(splitAttachmentLines(typed)).toEqual({
      text: typed,
      attachments: [],
    });
    expect(splitAttachmentLines("no files")).toEqual({
      text: "no files",
      attachments: [],
    });
  });
});

describe("what OpenCode is given inline", () => {
  test("an image, text/plain and a PDF, up to the 20 MiB OpenCode reads; nothing else", () => {
    expect(inlinesOnOpenCode(file("a.png", "image", "image/png"))).toBe(true);
    expect(inlinesOnOpenCode(file("a.txt", "file", "text/plain"))).toBe(true);
    expect(inlinesOnOpenCode(file("a.pdf", "file", "application/pdf"))).toBe(
      true,
    );
    expect(inlinesOnOpenCode(file("a.har", "file", "application/json"))).toBe(
      false,
    );
    expect(
      inlinesOnOpenCode(
        file("a.txt", "file", "text/plain", OPENCODE_INLINE_MAX_BYTES + 1),
      ),
    ).toBe(false);
  });
});
