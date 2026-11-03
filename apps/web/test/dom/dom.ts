/**
 * What a test needs to *use* a mounted component rather than read its markup.
 *
 * `preload.ts` gives `bun test` a DOM; this is the small amount on top of it that stands in
 * for a person. It is deliberately not a testing-library: three functions, each of which
 * says what it does not do.
 */
import { flushSync, mount, tick, unmount } from "svelte";
import type { Component } from "svelte";

/** Lets everything already in flight finish, then the DOM it caused. */
export const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
  flushSync();
};

/**
 * A mounted component, and the function that takes it away again.
 *
 * Every test mounts into its own element and unmounts in `afterEach`: a component left
 * mounted keeps its window `keydown` listener, and the next test's Escape would close this
 * one's dialog too.
 */
export interface Mounted {
  readonly target: HTMLElement;
  readonly destroy: () => void;
}

export const mountInto = <Props extends Record<string, unknown>>(
  component: Component<Props>,
  props: Props,
): Mounted => {
  const target = document.body.appendChild(document.createElement("div"));
  const instance = mount(component, { target, props });
  flushSync();
  return {
    target,
    destroy: () => {
      void unmount(instance);
      target.remove();
    },
  };
};

/**
 * A click, as the app's own handlers see one.
 *
 * It dispatches a bubbling, composed `MouseEvent` rather than calling `element.click()`.
 * Svelte delegates `click` — one listener on the mount root — and a review driving a browser
 * through an automation tool found that only a dispatched mouse event reached this app's
 * handlers there. That did not reproduce here: `element.click()` also reaches them in
 * happy-dom, and in headless Chrome. So nothing in these tests depends on the difference;
 * the dispatched event is used because it is the one that worked in every place it was
 * tried.
 *
 * **It does not move focus.** A browser focuses a button when the mouse goes down on it;
 * a dispatched event does not. A test that is about where focus *was* when the click
 * happened calls `element.focus()` first, which is what the person's hand did.
 */
export const click = (element: Element): void => {
  clickOn(element);
};

/**
 * The same click, with whatever a hand was holding down, and the event itself back.
 *
 * Two things {@link click} cannot express, both of which a link needs. A modifier key or a
 * non-primary button is the browser's own vocabulary — new tab, new window, save — and a
 * test about a link has to be able to send one. And whether the app called
 * `preventDefault` is the whole question for an `<a href>`: it is the difference between
 * routing in place and letting the document reload, and the only witness to it is the
 * event, so it is returned rather than dropped.
 */
export const clickOn = (
  element: Element,
  init: MouseEventInit = {},
): MouseEvent => {
  const event = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    composed: true,
    ...init,
  });
  element.dispatchEvent(event);
  flushSync();
  return event;
};

/**
 * A key going down on whatever has focus, bubbling up to the window.
 *
 * `Modal` listens on the window, so the event is sent from the focused element and left to
 * bubble — which is the path a real key takes — rather than dispatched at the window
 * directly, where a listener on the element in between would never be asked.
 *
 * **It does not move focus.** A browser moves focus on an uncancelled Tab; happy-dom does
 * not. So the event is returned: whether the app cancelled it is what says a trap took the
 * key, and where focus is afterwards is then only what the app itself moved it to.
 */
export const press = (
  key: string,
  options: KeyboardEventInit = {},
): KeyboardEvent => {
  const from = document.activeElement ?? document.body;
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    composed: true,
    ...options,
  });
  from.dispatchEvent(event);
  flushSync();
  return event;
};

/**
 * Enter in a text field, and what a browser does next that happy-dom does not.
 *
 * A browser that sees an uncancelled Enter in a text field with a form owner performs
 * *implicit submission*: it clicks that form's default button — its first submit button in
 * tree order — if there is one and it is enabled. happy-dom dispatches the event and stops,
 * so `press("Enter")` in a field cannot show whether Enter there submits anything. This
 * takes the browser's step for it, from the field's real form owner: a field that is not in
 * a form submits nothing, which is what a test about that question needs to be able to see.
 */
export const pressEnterIn = (field: HTMLInputElement): void => {
  field.focus();
  const event = new KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  field.dispatchEvent(event);
  const form = field.form;
  if (!event.defaultPrevented && form !== null) {
    const submitter = [...form.elements].find(
      (each): each is HTMLButtonElement | HTMLInputElement =>
        (each instanceof HTMLButtonElement && each.type === "submit") ||
        (each instanceof HTMLInputElement &&
          (each.type === "submit" || each.type === "image")),
    );
    if (submitter !== undefined && !submitter.disabled) submitter.click();
  }
  flushSync();
};

/** The element a person would call "the one with focus", described the way a failure reads. */
export const focused = (): string => {
  const element = document.activeElement;
  if (element === null) return "nothing";
  const name = element.getAttribute("aria-label");
  return `<${element.tagName.toLowerCase()}${
    element.className === "" ? "" : ` class="${element.className}"`
  }${name === null ? "" : ` aria-label="${name}"`}>`;
};
