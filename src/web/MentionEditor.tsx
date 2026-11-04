import {
  Component,
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from 'react';
import type { AuthoredContent } from '../contracts/participation.js';
import {
  editMentionPresentation,
  mentionPresentation,
  type MentionSelection,
} from './composer-mentions.js';

type Value = Pick<AuthoredContent, 'text' | 'mentions'>;
type Snapshot = { value: Value; selection: MentionSelection };
type Presentation = ReturnType<typeof mentionPresentation>;
type NativeSelection = MentionSelection & { direction: 'forward' | 'backward' | 'none' };
type SelectionProps = {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  wireText: string;
  presentation: Presentation;
  restored: (selection: MentionSelection) => void;
  children: ReactNode;
};

// React may replace a controlled textarea value before layout effects run. Read
// native selection before that mutation, including selections whose events have
// not reached React yet. This boundary adds no DOM node or editor lifetime.
class MentionSelectionSnapshot extends Component<SelectionProps, {}, NativeSelection | null> {
  override getSnapshotBeforeUpdate(previous: SelectionProps): NativeSelection | null {
    const input = this.props.inputRef.current;
    if (
      !input ||
      previous.wireText !== this.props.wireText ||
      previous.presentation.text === this.props.presentation.text
    )
      return null;
    return {
      start: this.props.presentation.displayOffset(
        previous.presentation.wireOffset(input.selectionStart),
      ),
      end: this.props.presentation.displayOffset(
        previous.presentation.wireOffset(input.selectionEnd),
      ),
      direction: input.selectionDirection,
    };
  }
  override componentDidUpdate(
    _previous: SelectionProps,
    _state: {},
    selection: NativeSelection | null,
  ) {
    if (!selection) return;
    this.props.inputRef.current?.setSelectionRange(
      selection.start,
      selection.end,
      selection.direction,
    );
    this.props.restored(selection);
  }
  override render() {
    return this.props.children;
  }
}

export function MentionEditor({
  value,
  names,
  disabled,
  label,
  inputRef,
  onChange,
  onSelection,
}: {
  value: Value;
  names: Record<string, string>;
  disabled: boolean;
  label: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onChange: (value: Value) => void;
  onSelection: (selection: MentionSelection) => void;
}) {
  const presentation = mentionPresentation(value, names);
  const history = useRef<{ past: Snapshot[]; future: Snapshot[] }>({ past: [], future: [] });
  const current = useRef<Snapshot>({ value, selection: { start: 0, end: 0 } });
  const composing = useRef(false),
    compositionSaved = useRef(false);
  const replaced = useRef<MentionSelection | undefined>(undefined);
  const caret = useRef<MentionSelection | undefined>(undefined);
  function remember(snapshot: Snapshot) {
    history.current.past.push(snapshot);
    // The journal has its own durable bounds; this is only one mounted editor's undo.
    if (history.current.past.length > 100) history.current.past.shift();
    history.current.future = [];
  }
  useLayoutEffect(() => {
    if (
      current.current.value.text !== value.text ||
      current.current.value.mentions !== value.mentions
    ) {
      remember(current.current);
      current.current = { value, selection: current.current.selection };
    }
    if (caret.current) {
      inputRef.current?.setSelectionRange(caret.current.start, caret.current.end);
      caret.current = undefined;
    }
  }, [value.text, value.mentions, names]);
  function select() {
    const input = inputRef.current;
    if (!input) return;
    current.current.selection = { start: input.selectionStart, end: input.selectionEnd };
    onSelection({
      start: presentation.wireOffset(input.selectionStart),
      end: presentation.wireOffset(input.selectionEnd),
    });
  }
  function travel(redo: boolean) {
    const from = redo ? history.current.future : history.current.past;
    const snapshot = from.pop();
    if (!snapshot || disabled) return;
    (redo ? history.current.past : history.current.future).push(current.current);
    current.current = snapshot;
    caret.current = snapshot.selection;
    onChange(snapshot.value);
  }
  const beforeInput = useRef<(event: InputEvent) => void>(() => {});
  beforeInput.current = (event) => {
    if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
      event.preventDefault();
      travel(event.inputType === 'historyRedo');
      return;
    }
    const input = inputRef.current!;
    replaced.current = { start: input.selectionStart, end: input.selectionEnd };
  };
  useEffect(() => {
    const input = inputRef.current;
    const handle = (event: Event) => beforeInput.current(event as InputEvent);
    input?.addEventListener('beforeinput', handle);
    return () => input?.removeEventListener('beforeinput', handle);
  }, []);
  return (
    <MentionSelectionSnapshot
      inputRef={inputRef}
      wireText={value.text}
      presentation={presentation}
      restored={(selection) => {
        current.current.selection = { start: selection.start, end: selection.end };
      }}
    >
      <textarea
        aria-label={label}
        ref={inputRef}
        rows={7}
        value={presentation.text}
        disabled={disabled}
        onSelect={select}
        onCompositionStart={() => {
          composing.current = true;
          compositionSaved.current = false;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onPaste={(event) => {
          event.preventDefault();
          const input = inputRef.current!;
          const range = { start: input.selectionStart, end: input.selectionEnd };
          const pasted = event.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n');
          const displayed =
            presentation.text.slice(0, range.start) + pasted + presentation.text.slice(range.end);
          const next = editMentionPresentation(value, names, displayed, range);
          remember(current.current);
          caret.current = { start: range.start + pasted.length, end: range.start + pasted.length };
          current.current = { value: next, selection: caret.current };
          replaced.current = undefined;
          onChange(next);
        }}
        onKeyDown={(event) => {
          if (
            (event.metaKey || event.ctrlKey) &&
            !event.altKey &&
            ['z', 'y'].includes(event.key.toLowerCase()) &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            travel(event.shiftKey || event.key.toLowerCase() === 'y');
          }
        }}
        onChange={(event) => {
          let range = replaced.current;
          const removed = presentation.text.length - event.target.value.length;
          if (range && range.start === range.end && removed > 0) {
            // Word/line deletion ranges are collapsed in textarea beforeinput.
            // The resulting caret disambiguates identical displayed recipients.
            range = {
              start: event.target.selectionStart,
              end: event.target.selectionStart + removed,
            };
          }
          const next = editMentionPresentation(value, names, event.target.value, range);
          replaced.current = undefined;
          if (!composing.current || !compositionSaved.current) remember(current.current);
          compositionSaved.current = composing.current;
          current.current = {
            value: next,
            selection: { start: event.target.selectionStart, end: event.target.selectionEnd },
          };
          onChange(next);
        }}
      />
    </MentionSelectionSnapshot>
  );
}
