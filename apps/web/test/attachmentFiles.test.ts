/**
 * What an attachment chip opens a file as (A6 U13). A blob URL is this page's own origin, so
 * a file opened under a type the browser renders actively would run as bit itself: HTML,
 * SVG and XHTML must never be opened as such (U13 review 1, finding 4).
 */
import { describe, expect, test } from "bun:test";

import { openableType } from "../src/lib/attachmentFiles";

/** The only types a tab may be given: each shows its bytes inertly. */
const INERT = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
  "text/plain;charset=utf-8",
]);

describe("the type an attachment is opened as", () => {
  test("HTML, in any case or with parameters, opens as plain text: its source, never a page", () => {
    for (const type of [
      "text/html",
      "TEXT/HTML",
      "text/html; charset=utf-8",
      "text/xml",
      "application/xml",
      "text/javascript",
    ]) {
      expect(openableType(type)).toBe("text/plain;charset=utf-8");
    }
  });

  test("SVG, XHTML and every type not known to be inert are not opened at all, only saved", () => {
    for (const type of [
      "image/svg+xml",
      "IMAGE/SVG+XML",
      "application/xhtml+xml",
      "application/javascript",
      "application/octet-stream",
      "application/x-shockwave-flash",
      "multipart/x-mixed-replace",
      "image/heic",
      "image/bmp",
      "",
      "not a type",
    ]) {
      expect(openableType(type)).toBeUndefined();
    }
  });

  test("whatever the type, a tab is only ever given an inert one", () => {
    for (const type of [
      "text/html",
      "image/svg+xml",
      "application/xhtml+xml",
      "text/xml",
      "application/xml",
      "image/png",
      "application/pdf",
      "text/plain",
      "text/markdown",
      "application/json",
      "image/x-unknown",
      "application/vnd.ms-htmlhelp",
    ]) {
      const opened = openableType(type);
      if (opened !== undefined) expect(INERT.has(opened)).toBe(true);
    }
  });

  test("the inert types open as themselves; text and JSON as plain text", () => {
    for (const type of ["image/png", "image/webp", "application/pdf"]) {
      expect(openableType(type)).toBe(type);
    }
    expect(openableType("application/json")).toBe("text/plain;charset=utf-8");
    expect(openableType("text/plain")).toBe("text/plain;charset=utf-8");
  });
});
