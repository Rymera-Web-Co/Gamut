import { FolderOpen, Play } from "lucide-react";

import { Button } from "@/components/ui/button";
import { pickAudioFile } from "@/lib/ipc";
import { type TerminalSound } from "@/lib/settings";
import { BUILTIN_SOUNDS, ensureDesktopPermission, playSound } from "@/features/terminal/notify";
import { Divider, Field, PanelTitle, Select, Toggle, useSetting } from "../controls";

export function NotificationsPanel() {
  const [sound, setSound] = useSetting("terminalNotifySound");
  const [onExit, setOnExit] = useSetting("terminalNotifyOnExit");
  const [onBell, setOnBell] = useSetting("terminalNotifyOnBell");
  const [soundName, setSoundName] = useSetting("terminalNotifySoundName");
  const [customPath, setCustomPath] = useSetting("terminalNotifySoundCustom");
  const [desktop, setDesktop] = useSetting("terminalNotifyDesktop");
  const [always, setAlways] = useSetting("terminalNotifyAlways");

  const chooseCustom = async () => {
    const path = await pickAudioFile();
    if (path) {
      setCustomPath(path);
      setSoundName("custom");
    }
  };

  const onSelectSound = (v: TerminalSound) => {
    setSoundName(v);
    // Selecting "Custom…" with nothing chosen yet opens the picker straight away.
    if (v === "custom" && !customPath) void chooseCustom();
  };

  const customName = customPath.split(/[\\/]/).pop() || customPath;

  const toggleDesktop = (next: boolean) => {
    // Prompt for OS permission the moment the user opts in, rather than on the
    // first background event. Leave the preference on regardless — the send
    // path re-checks, so a later grant in System Settings just starts working.
    if (next) void ensureDesktopPermission();
    setDesktop(next);
  };

  return (
    <div>
      <PanelTitle>Notifications</PanelTitle>
      <p className="mb-2 text-xs text-[var(--color-muted-foreground)]">
        Alerts for terminal events — a process exiting or a bell (e.g. Claude Code finishing a task
        or asking for input). These fire for background panes and whenever the Gamut window is
        unfocused; the focused pane stays silent while you're looking at it unless you enable
        "Notify even when focused" below.
      </p>
      <Field
        label="Play sound on terminal events"
        hint="An audible cue when a background pane signals an event."
      >
        <Toggle checked={sound} onChange={setSound} />
      </Field>
      <Divider />
      <Field label="Notify on process exit" hint="A background shell process ends.">
        <Toggle checked={onExit} onChange={setOnExit} />
      </Field>
      <Field label="Notify on terminal bell" hint="A pane rings the bell (\a).">
        <Toggle checked={onBell} onChange={setOnBell} />
      </Field>
      <Field
        label="Notify even when focused"
        hint="Cue events for the active pane too, not just background panes or an unfocused window."
      >
        <Toggle checked={always} onChange={setAlways} />
      </Field>
      <Divider />
      <Field label="Sound" hint="Plays for the events selected above.">
        <div className="flex items-center gap-2">
          <Select
            value={soundName}
            onChange={onSelectSound}
            options={[
              ...BUILTIN_SOUNDS.map((s) => ({ value: s.id, label: s.label })),
              { value: "custom" as TerminalSound, label: "Custom…" },
            ]}
          />
          <Button variant="outline" size="sm" className="h-8" onClick={() => playSound(soundName)}>
            <Play className="size-3.5" />
            Test
          </Button>
        </div>
      </Field>
      {soundName === "custom" && (
        <Field
          label="Custom sound file"
          hint={customPath ? customName : "Pick a .wav, .mp3, .ogg, .m4a, .aac or .flac file."}
        >
          <Button variant="outline" size="sm" className="h-8" onClick={chooseCustom}>
            <FolderOpen className="size-3.5" />
            {customPath ? "Change…" : "Choose file…"}
          </Button>
        </Field>
      )}
      <Divider />
      <Field
        label="Show desktop notification"
        hint="Also post a native OS notification. Needs notification permission; respects Do Not Disturb."
      >
        <Toggle checked={desktop} onChange={toggleDesktop} />
      </Field>
    </div>
  );
}
