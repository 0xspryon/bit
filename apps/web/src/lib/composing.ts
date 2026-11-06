/**
 * Whether a key event belongs to an input method's composition (A7-Q review 2): an IME
 * converting kana, pinyin or a dead-key sequence sends its Enter (accept the candidate) and
 * its Esc (cancel the conversion) to the field as ordinary keydowns, which a handler must
 * leave to the IME. `isComposing` is the standard flag; `keyCode` 229 is what Safari and
 * older engines send instead for a key the IME took. Every Enter or Esc handler on a text
 * field asks this first.
 */
export const composing = (event: KeyboardEvent): boolean =>
  event.isComposing || event.keyCode === 229;
