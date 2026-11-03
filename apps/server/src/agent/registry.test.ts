/**
 * The agent registry: lookup, what the browser is shown, the importer's grant, and its
 * prompts — which must be exactly what they were before the registry existed.
 *
 * The prompt pins are SHA-256 digests of the importer's output **taken before the registry
 * was introduced**, over one input per branch of the opener (one page, several, none with a
 * message, none carrying an earlier session's pages) and the resume and follow-up. A change
 * to the importer's text, or to how it is reached, moves a digest. If a change is meant,
 * recompute them and say in the commit what the importer is now told.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { AgentView } from "@bit/contracts";
import { Schema } from "effect";

import {
  assembleImporterFollowUpPrompt,
  assembleImporterPrompt,
  assembleImporterResumePrompt,
} from "../import/importerPrompt";
import { importSessionAgent } from "../import/importerHistory";
import { ImporterToolkit } from "../mcp/importerTools";
import {
  AGENTS,
  DEFAULT_AGENT_ID,
  IMPORTER_AGENT,
  agentById,
  agentView,
} from "./registry";

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

const A = "https://hackerone.com/acme/policy";
const B = "https://acme.test/security";

describe("the registry", () => {
  test("holds one agent, the importer, and opens new sessions as it", () => {
    expect(AGENTS.map((agent) => agent.id)).toEqual(["importer"]);
    expect(DEFAULT_AGENT_ID).toBe("importer");
  });

  test("finds an agent by its id, and answers undefined for one it does not define", () => {
    expect(agentById("importer")).toBe(IMPORTER_AGENT);
    expect(agentById("retired_agent")).toBeUndefined();
    expect(agentById("")).toBeUndefined();
    // An id is matched exactly: a row's spelling is not normalised into another agent.
    expect(agentById("Importer")).toBeUndefined();
  });

  test("an import session may run as the importer, and as nothing it does not define", () => {
    expect(importSessionAgent("importer")).toBe(IMPORTER_AGENT);
    expect(importSessionAgent("retired_agent")).toBeUndefined();
  });

  test("shows the browser its id, label and what it writes, and nothing of its prompt or grant", () => {
    const view = agentView(IMPORTER_AGENT);
    expect(view).toEqual({
      id: "importer",
      label: "Importer",
      writes: IMPORTER_AGENT.writes,
    });
    expect(Object.keys(view).sort()).toEqual(["id", "label", "writes"]);
    // And it is the contract's shape, so the route encodes it as it stands.
    expect(Schema.decodeUnknownSync(AgentView)(view)).toEqual(view);
  });
});

describe("the importer's authority", () => {
  test("is the importer credential kind, and the importer toolkit's three tools exactly", () => {
    expect(IMPORTER_AGENT.authority.role).toBe("importer");
    expect([...IMPORTER_AGENT.authority.tools].sort()).toEqual([
      "add_scope_entry",
      "read_scope",
      "record_imported_asset",
    ]);
    // Read off the toolkit the endpoint serves, so the two cannot drift.
    expect(IMPORTER_AGENT.authority.tools).toEqual(
      Object.keys(ImporterToolkit.tools),
    );
  });
});

describe("the importer's prompts, unchanged by the registry", () => {
  const openers = {
    one: { targetName: "Acme", links: [A] },
    many: { targetName: "Acme", links: [A, B] },
    message: { targetName: "Acme", links: [], message: "Load the scope." },
    earlier: {
      targetName: "Acme",
      links: [],
      message: "Carry on.",
      earlierPages: [A, B],
    },
  } as const;

  const pinned = {
    one: "34cc5250b513a4d3d3a34903f88be39f21936e8e03e5251a59a212f466dab0f7",
    many: "5e206dc420ef1677d2176cb69cca3f71895c499bbcd95f951cb11f46d730a0b5",
    message: "aca1a25ae517d7ee3a4f8d8e6254907d8385c4719587984b66c1e5fc817f7db4",
    earlier: "74656f9bcdb074cf6f11397e837c412d2a0619bbdf6883ff3f4854d3eaca35cd",
  } as const;

  for (const name of Object.keys(openers) as (keyof typeof openers)[]) {
    test(`the opener (${name}) is byte for byte what it was`, () => {
      const viaRegistry = IMPORTER_AGENT.prompt.opening(openers[name]);
      expect(sha256(viaRegistry)).toBe(pinned[name]);
      expect(viaRegistry).toBe(assembleImporterPrompt(openers[name]));
    });
  }

  test("the resume note is byte for byte what it was", () => {
    const viaRegistry = IMPORTER_AGENT.prompt.resume({ message: "Carry on." });
    expect(sha256(viaRegistry)).toBe(
      "0e7c3d14e82128feaaaf4c48c9028ee56b154d2cfe82b885f02ec5e7385371dd",
    );
    expect(viaRegistry).toBe(
      assembleImporterResumePrompt({ message: "Carry on." }),
    );
  });

  test("a later message is still the operator's words verbatim", () => {
    const viaRegistry = IMPORTER_AGENT.prompt.followUp({ message: "More." });
    expect(viaRegistry).toBe("More.");
    expect(sha256(viaRegistry)).toBe(
      "2e823667482aae3d8353944b920f4eabeeb9c2b7347ba19f05d4d16a32bd460d",
    );
    expect(viaRegistry).toBe(
      assembleImporterFollowUpPrompt({ message: "More." }),
    );
  });
});
