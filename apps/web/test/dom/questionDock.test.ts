/**
 * A7-Q's question dock (E3/E4), drawn by the shell for a chat that asks: every question
 * kind, Jump to…, Esc against Esc inside a list, focus in and out, the answers sent, the
 * `message` fallback and the `not_resumable` sentence. Through the fake chat, so it is the
 * shell's own dock any chat gets. Strings and booleans only, never `toEqual` on a node.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { flushSync, mount, unmount } from "svelte";

import type { QuestionAnswerability, QuestionField } from "@bit/contracts";

import { click, focused, press, settle } from "./dom";

const { default: FakeChatShell } =
  await import("./fixtures/FakeChatShell.svelte");

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const each of cleanups) each();
  cleanups = [];
});

const asking = async (
  options: {
    readonly fields?: readonly QuestionField[];
    readonly answerability?: QuestionAnswerability;
    readonly canMessage?: boolean;
    readonly asking?: boolean;
  } = {},
) => {
  const calls: string[] = [];
  const root = document.body.appendChild(document.createElement("div"));
  const chat = mount(FakeChatShell, {
    target: root,
    props: { asking: true, ...options, calls },
  });
  cleanups.push(() => {
    void unmount(chat);
    root.remove();
  });
  flushSync();
  await settle();
  const set = async (next: Parameters<typeof chat.set>[0]) => {
    chat.set(next);
    await settle();
  };
  return { calls, root, set };
};

const dock = (root: HTMLElement): HTMLElement => {
  const found = root.querySelector<HTMLElement>(
    ".stack > .dock section.question-dock",
  );
  if (found === null) throw new Error("no dock");
  return found;
};
const buttonNamed = (root: HTMLElement, name: string): HTMLButtonElement => {
  const found = [...root.querySelectorAll("button")].find(
    (each) =>
      (each.getAttribute("aria-label") ?? each.textContent ?? "").trim() ===
      name,
  );
  if (found === undefined) throw new Error(`no button "${name}"`);
  return found;
};
const text = (element: Element | null): string =>
  (element?.textContent ?? "").replace(/\s+/gu, " ").trim();
const options = (root: HTMLElement): HTMLInputElement[] => [
  ...root.querySelectorAll<HTMLInputElement>(
    ".current input[type=radio], .current input[type=checkbox]",
  ),
];
const write = async (
  field: HTMLInputElement | HTMLTextAreaElement,
  words: string,
) => {
  field.value = words;
  field.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
};
const field = (
  over: Partial<QuestionField> & Pick<QuestionField, "key">,
): QuestionField => ({
  header: null,
  question: `${over.key}?`,
  kind: "one",
  options: [
    { label: "Yes", description: null },
    { label: "No", description: null },
  ],
  custom: true,
  required: false,
  ...over,
});

describe("the dock in the composer's slot", () => {
  test("it replaces a focused box and takes the focus, on the first question's first option", async () => {
    const { root, set } = await asking({ asking: false });
    const box = root.querySelector("textarea");
    box?.focus();
    expect(document.activeElement === box).toBe(true);
    await set({ asking: true });
    await settle();
    expect(root.querySelector("textarea")).toBeNull();
    expect(dock(root).contains(document.activeElement)).toBe(true);
    expect(focused()).toContain("<input");
    expect(document.activeElement === options(root)[0]).toBe(true);
  });

  test("the header counts, the bar has one segment a question, and the region is named", async () => {
    const { root } = await asking();
    const region = dock(root);
    expect(region.getAttribute("aria-label")).toBe("The agent's questions");
    expect(text(region.querySelector(".counter"))).toBe("Question 1 of 2");
    expect(region.querySelectorAll(".bar .segment").length).toBe(2);
    expect(region.querySelectorAll(".bar .segment.is-current").length).toBe(1);
    // The full interface at any count: Jump to… is there for two questions too.
    expect(buttonNamed(root, "Jump to…").getAttribute("aria-haspopup")).toBe(
      "listbox",
    );
  });

  test("past twelve questions the bar is one continuous run", async () => {
    const many = Array.from({ length: 14 }, (_, at) =>
      field({ key: `q${String(at)}` }),
    );
    const { root } = await asking({ fields: many });
    expect(dock(root).querySelectorAll(".bar .segment").length).toBe(0);
    expect(dock(root).querySelector(".bar .run")).not.toBeNull();
    expect(text(dock(root).querySelector(".counter"))).toBe("Question 1 of 14");
  });
});

describe("every kind of question", () => {
  test("choose one: radios in a radiogroup, an option replaced by words in the own-words row", async () => {
    const { root } = await asking();
    expect(text(root.querySelector(".current .tag"))).toBe("Choose one");
    expect(text(root.querySelector(".current .requirement"))).toBe("Optional");
    expect(root.querySelector(".current [role=radiogroup]")).not.toBeNull();
    expect(
      options(root)
        .map((each) => each.type)
        .join(","),
    ).toBe("radio,radio");
    expect(text(root.querySelector(".current .description"))).toBe("The API");
    click(options(root)[1]!);
    await settle();
    expect(options(root)[1]?.checked).toBe(true);
    const own = root.querySelector<HTMLInputElement>(".current input.own");
    expect(own?.getAttribute("aria-label")).toBe(
      "Something else, in your own words",
    );
    await write(own!, "staging only");
    expect(options(root).some((each) => each.checked)).toBe(false);
  });

  test("choose any: checkboxes, and the count chosen in Required's place", async () => {
    const { root } = await asking();
    click(buttonNamed(root, "Next question"));
    await settle();
    expect(text(root.querySelector(".current .tag"))).toBe("Choose any");
    expect(
      options(root)
        .map((each) => each.type)
        .join(","),
    ).toBe("checkbox,checkbox,checkbox");
    click(options(root)[0]!);
    click(options(root)[2]!);
    await settle();
    expect(text(root.querySelector(".current .requirement"))).toBe(
      "2 selected",
    );
  });

  test("your words: a textarea; required says so, and Next waits for an answer", async () => {
    const { root, calls } = await asking({
      fields: [
        field({
          key: "Notify whom",
          kind: "text",
          options: [],
          required: true,
        }),
        field({ key: "Then", required: false }),
      ],
    });
    expect(text(root.querySelector(".current .tag"))).toBe("Your words");
    expect(text(root.querySelector(".current .requirement"))).toBe("Required");
    const next = root.querySelector<HTMLButtonElement>(".foot .primary");
    expect(next?.disabled).toBe(true);
    // Not offered on a required question.
    expect(
      [...root.querySelectorAll(".foot button")].some(
        (each) => text(each) === "Skip",
      ),
    ).toBe(false);
    const words = root.querySelector<HTMLTextAreaElement>(".current textarea");
    await write(words!, "security@acme.test");
    expect(next?.disabled).toBe(false);
    // Ctrl Enter in the box moves on; a plain Enter is a new line.
    words?.focus();
    press("Enter");
    await settle();
    expect(text(dock(root).querySelector(".counter"))).toBe("Question 1 of 2");
    press("Enter", { ctrlKey: true });
    await settle();
    expect(text(dock(root).querySelector(".counter"))).toBe("Question 2 of 2");
    expect(calls.join(",")).toBe("");
  });

  test("an optional question can be skipped, and is counted as skipped", async () => {
    const { root } = await asking({
      fields: [field({ key: "A" }), field({ key: "B" }), field({ key: "C" })],
    });
    click(buttonNamed(root, "Skip"));
    await settle();
    expect(text(root.querySelector(".answered-count"))).toBe("1 skipped");
  });

  test("number keys choose: a choose-one's option, a choose-any's toggle, and the next number the own-words row", async () => {
    const { root } = await asking();
    options(root)[0]?.focus();
    press("2");
    await settle();
    expect(options(root)[1]?.checked).toBe(true);
    press("3");
    await settle();
    expect(document.activeElement?.classList.contains("own") ?? false).toBe(
      true,
    );
    click(buttonNamed(root, "Next question"));
    await settle();
    options(root)[0]?.focus();
    press("1");
    press("3");
    await settle();
    expect(
      options(root)
        .map((each) => String(each.checked))
        .join(","),
    ).toBe("true,false,true");
  });
});

describe("Jump to…, and Esc", () => {
  test("Jump to… lists every question by name, and Enter on one goes there", async () => {
    const { root } = await asking({
      fields: [
        field({ key: "A", header: "Alpha" }),
        field({ key: "B", header: "Bravo" }),
        field({ key: "C", header: "Charlie" }),
      ],
    });
    const jump = buttonNamed(root, "Jump to…");
    click(jump);
    await settle();
    expect(jump.getAttribute("aria-expanded")).toBe("true");
    const list = root.querySelector("[role=listbox]");
    expect(
      [...(list?.querySelectorAll("[role=option] .jump-name") ?? [])]
        .map((each) => text(each))
        .join(","),
    ).toBe("Alpha,Bravo,Charlie");
    expect(document.activeElement?.getAttribute("role")).toBe("option");
    press("ArrowDown");
    press("ArrowDown");
    press("Enter");
    await settle();
    expect(root.querySelector("[role=listbox]")).toBeNull();
    expect(text(dock(root).querySelector(".counter"))).toBe("Question 3 of 3");
    expect(text(root.querySelector(".current .title"))).toBe("C?");
  });

  test("Esc in the Jump to… list closes the list only: the question stays, focus is back on the button", async () => {
    const { root, calls } = await asking();
    const jump = buttonNamed(root, "Jump to…");
    click(jump);
    await settle();
    const escape = press("Escape");
    await settle();
    expect(escape.defaultPrevented).toBe(true);
    expect(root.querySelector("[role=listbox]")).toBeNull();
    expect(calls.join(",")).toBe("");
    expect(root.querySelector(".stack > .dock")).not.toBeNull();
    expect(document.activeElement === jump).toBe(true);
  });

  test("Esc on the question dismisses it: the box is back and focused", async () => {
    const { root, calls } = await asking();
    options(root)[0]?.focus();
    press("Escape");
    await settle();
    expect(calls.join(",")).toBe("dismiss");
    expect(root.querySelector(".stack > .dock")).toBeNull();
    expect(document.activeElement === root.querySelector("textarea")).toBe(
      true,
    );
  });

  test("the header's dismiss says what it does, and does it", async () => {
    const { root, calls } = await asking();
    const dismiss = buttonNamed(root, "Dismiss these questions");
    expect(dismiss.getAttribute("title")).toContain("told you declined");
    click(dismiss);
    await settle();
    expect(calls.join(",")).toBe("dismiss");
  });
});

describe("sending, and what cannot be sent", () => {
  test("with nothing answered the last button sends nothing; answering none is Dismiss", async () => {
    const { root, calls } = await asking({ fields: [field({ key: "Only" })] });
    const send = root.querySelector<HTMLButtonElement>(".foot .primary");
    expect(text(send)).toBe("Send answers");
    expect(send?.disabled).toBe(true);
    options(root)[0]?.focus();
    press("Enter");
    await settle();
    expect(calls.join(",")).toBe("");
  });

  test("nothing goes before the last question, whose button sends every answer", async () => {
    const { root, calls } = await asking();
    click(options(root)[0]!);
    await settle();
    click(buttonNamed(root, "Next"));
    await settle();
    expect(calls.join(",")).toBe("");
    expect(text(root.querySelector(".answered-count"))).toBe("1 answered");
    expect(text(root.querySelector(".answered-last"))).toBe(
      "Host → api.acme.com",
    );
    click(options(root)[1]!);
    await settle();
    const send = root.querySelector<HTMLButtonElement>(".foot .primary");
    expect(text(send)).toBe("Send 2 answers");
    click(send!);
    await settle();
    expect(calls.join("|")).toBe(
      'answer:{"Which host first?":["api.acme.com"],"Which depths?":["Two"]}',
    );
  });

  test("Show lists what was answered, and a row goes back to its question", async () => {
    const { root } = await asking();
    click(options(root)[0]!);
    click(buttonNamed(root, "Next"));
    await settle();
    const show = buttonNamed(root, "Show");
    click(show);
    await settle();
    expect(show.getAttribute("aria-expanded")).toBe("true");
    const row = root.querySelector<HTMLButtonElement>(".answered-row");
    expect(text(row)).toBe("Host → api.acme.com");
    click(row!);
    await settle();
    expect(text(dock(root).querySelector(".counter"))).toBe("Question 1 of 2");
  });

  test("busy while the server has it; a refusal is the error dialog, and the answers stay", async () => {
    const { root, set } = await asking();
    click(options(root)[0]!);
    await set({ busy: true });
    expect(options(root)[0]?.disabled).toBe(true);
    expect(dock(root).getAttribute("aria-busy")).toBe("true");
    await set({ busy: false, refused: "The agent is no longer waiting." });
    const dialog = document.querySelector("[role=alertdialog]");
    expect(text(dialog)).toContain("Answers not sent");
    expect(text(dialog)).toContain("The agent is no longer waiting.");
    click(buttonNamed(document.body, "Close"));
    await settle();
    expect(document.querySelector("[role=alertdialog]")).toBeNull();
    expect(options(root)[0]?.checked).toBe(true);
  });

  test("`message`: the request is gone, it says so, and the answers go as an ordinary message", async () => {
    const { root, calls } = await asking({ answerability: "message" });
    expect(text(root.querySelector(".note"))).toContain(
      "no longer waiting on these questions",
    );
    expect(text(root.querySelector(".note"))).toContain("ordinary message");
    click(options(root)[1]!);
    click(buttonNamed(root, "Next"));
    await settle();
    click(options(root)[2]!);
    await settle();
    const send = root.querySelector<HTMLButtonElement>(".foot .primary");
    expect(text(send)).toBe("Send 2 answers as a message");
    click(send!);
    await settle();
    expect(calls.join("|")).toBe(
      "message:My answers to your questions:\n- Which host first? — www.acme.com\n- Which depths? — All",
    );
    // The message was sent, so the box is back.
    expect(root.querySelector(".stack > .dock")).toBeNull();
  });

  test("`not_resumable`, or `message` in a chat that takes none: read only, the sentence, and Dismiss", async () => {
    for (const options_ of [
      { answerability: "not_resumable" as const },
      { answerability: "message" as const, canMessage: false },
    ]) {
      const { root, calls } = await asking(options_);
      expect(text(root.querySelector(".note"))).toContain(
        "cannot be carried on",
      );
      expect(options(root).every((each) => each.disabled)).toBe(true);
      const buttons = [...root.querySelectorAll(".foot button")].map((each) =>
        text(each),
      );
      expect(buttons.join(",")).toBe("Dismiss");
      click(buttonNamed(root, "Dismiss"));
      await settle();
      expect(calls.join(",")).toBe("dismiss");
    }
  });
});
