import {
  Divider,
  Field,
  NumberField,
  PanelTitle,
  Segmented,
  TextField,
  Toggle,
  useSetting,
} from "../controls";

export function TerminalPanel() {
  const [terminalShell, setShell] = useSetting("terminalShell");
  const [terminalFontSize, setFontSize] = useSetting("terminalFontSize");
  const [terminalFontFamily, setFontFamily] = useSetting("terminalFontFamily");
  const [terminalCursorBlink, setCursorBlink] = useSetting("terminalCursorBlink");
  const [terminalScrollback, setScrollback] = useSetting("terminalScrollback");
  const [newTabDir, setNewTabDir] = useSetting("terminalNewTabDir");
  const [restoreSessions, setRestoreSessions] = useSetting("terminalRestoreSessions");

  return (
    <div>
      <PanelTitle>Terminal</PanelTitle>
      <Field label="Shell override" hint="Blank uses your login shell. Applies to new terminals.">
        <TextField value={terminalShell} onChange={setShell} placeholder="/bin/zsh" wide />
      </Field>
      <Divider />
      <Field label="Font size">
        <NumberField value={terminalFontSize} onChange={setFontSize} min={8} max={32} suffix="px" />
      </Field>
      <Field label="Font family" hint="Blank uses the built-in monospace stack.">
        <TextField
          value={terminalFontFamily}
          onChange={setFontFamily}
          placeholder="e.g. Cascadia Code"
        />
      </Field>
      <Divider />
      <Field label="Cursor blink">
        <Toggle checked={terminalCursorBlink} onChange={setCursorBlink} />
      </Field>
      <Field label="Scrollback" hint="Lines kept per terminal (new terminals).">
        <NumberField
          value={terminalScrollback}
          onChange={setScrollback}
          min={100}
          max={100000}
          step={100}
          suffix="lines"
        />
      </Field>
      <Divider />
      <Field
        label="New terminal directory"
        hint="Where ⌘/Ctrl+T opens. The selected repo always wins; this is the fallback when none is selected."
      >
        <Segmented
          value={newTabDir}
          onChange={setNewTabDir}
          options={[
            { value: "first", label: "First repo" },
            { value: "group", label: "Group folder" },
          ]}
        />
      </Field>
      <Divider />
      <Field
        label="Restore sessions on launch"
        hint="Reopen your terminal tabs and splits, respawning a fresh shell in each saved directory. Scrollback and running processes aren't restored."
      >
        <Toggle checked={restoreSessions} onChange={setRestoreSessions} />
      </Field>
    </div>
  );
}
