// Storage order is unspecified and may change after an unrelated insertion:
// https://html.spec.whatwg.org/multipage/webstorage.html#the-storage-interface
// Compare exact stored strings by key; parsing would hide byte-only mutations.
export function publicationJournalBytes(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(localStorage).filter(([key]) => key.startsWith('loom.intent.v1:')),
  );
}
