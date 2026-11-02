/**
 * The importer's two prompts, against plain strings (S3.1).
 *
 * `scopeImporter.test.ts` asserts what reaches a scripted harness; this is the arrangement
 * itself: the opener carries the rules once, the follow-up carries none of them, and a page
 * the operator types is read out of their words exactly.
 */
import { describe, expect, test } from "bun:test";

import { SCOPE_IMPORT_DATA_NOT_INSTRUCTIONS } from "@bit/contracts";

import {
  IMPORTER_PROMPT_DELIMITER,
  assembleImporterFollowUpPrompt,
  assembleImporterPrompt,
  operatorPages,
} from "./importerPrompt";

const PAGE = "https://hackerone.com/acme/policy";

describe("the opener", () => {
  test("from links alone is unchanged by the conversation: no delimiter, no operator section", () => {
    const prompt = assembleImporterPrompt({
      targetName: "Acme",
      links: [PAGE],
    });
    expect(prompt).toContain(PAGE);
    expect(prompt).not.toContain(IMPORTER_PROMPT_DELIMITER.trim());
    expect(prompt).not.toContain("has not given you any pages");
  });

  test("with no links carries the rules once and the operator's words last, below the delimiter", () => {
    const message = "Here is the program: https://bugcrowd.com/acme";
    const prompt = assembleImporterPrompt({
      targetName: "Acme",
      links: [],
      message,
    });
    expect(prompt).toContain(SCOPE_IMPORT_DATA_NOT_INSTRUCTIONS);
    expect(prompt).toContain("has not given you any pages yet");
    const at = prompt.indexOf(IMPORTER_PROMPT_DELIMITER);
    expect(at).toBeGreaterThan(0);
    // An exact split: what follows the delimiter is the message, byte for byte.
    expect(prompt.slice(at + IMPORTER_PROMPT_DELIMITER.length)).toBe(message);
  });
});

describe("the follow-up", () => {
  test("is the operator's words verbatim, with no copy of the rules, the tools or the links", () => {
    const message = "Also load the staging hosts.";
    const prompt = assembleImporterFollowUpPrompt({ message });
    expect(prompt).toBe(message);
    const opener = assembleImporterPrompt({
      targetName: "Acme",
      links: [PAGE],
    });
    // No line of the opener's framing travels with a later message.
    for (const line of opener.split("\n")) {
      if (line.trim().length < 20) continue;
      expect(prompt).not.toContain(line);
    }
  });
});

describe("the pages in an operator's message", () => {
  test("are read in order, once each, without the sentence's punctuation", () => {
    expect(
      operatorPages(
        `Read ${PAGE}. Then (https://bugcrowd.com/acme), and ${PAGE} again, then http://x.test/a?b=1!`,
      ),
    ).toEqual([PAGE, "https://bugcrowd.com/acme", "http://x.test/a?b=1"]);
  });

  test("ignore anything that is not a web address", () => {
    expect(operatorPages("ftp://acme.test and acme.com and https://")).toEqual(
      [],
    );
  });
});
