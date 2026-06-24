import { Monitor, Moon, Sun } from "lucide-react";

import { useTheme, type ThemePreference } from "@/lib/theme";
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

export function AppearancePanel() {
  const preference = useTheme((s) => s.preference);
  const setPreference = useTheme((s) => s.setPreference);
  const [editorFontSize, setEditorFontSize] = useSetting("editorFontSize");
  const [editorFontFamily, setEditorFontFamily] = useSetting("editorFontFamily");
  const [markdownPreviewByDefault, setMarkdownPreviewByDefault] = useSetting(
    "markdownPreviewByDefault",
  );
  const [toastTimeout, setToastTimeout] = useSetting("toastTimeout");

  return (
    <div>
      <PanelTitle>Appearance</PanelTitle>
      <Field label="Theme" hint="System follows your OS appearance.">
        <Segmented<ThemePreference>
          value={preference}
          onChange={setPreference}
          options={[
            { value: "light", label: <Sun className="size-3.5" />, title: "Light" },
            { value: "dark", label: <Moon className="size-3.5" />, title: "Dark" },
            {
              value: "system",
              label: <Monitor className="size-3.5" />,
              title: "System",
            },
          ]}
        />
      </Field>
      <Divider />
      <Field label="Editor font size">
        <NumberField
          value={editorFontSize}
          onChange={setEditorFontSize}
          min={8}
          max={32}
          suffix="px"
        />
      </Field>
      <Field label="Editor font family" hint="Leave blank for the editor default.">
        <TextField
          value={editorFontFamily}
          onChange={setEditorFontFamily}
          placeholder="e.g. JetBrains Mono"
        />
      </Field>
      <Field
        label="Open markdown in preview"
        hint="Show .md files rendered by default. The Edit/Preview toggle still switches per file."
      >
        <Toggle checked={markdownPreviewByDefault} onChange={setMarkdownPreviewByDefault} />
      </Field>
      <Divider />
      <Field label="Toast auto-dismiss">
        <NumberField
          value={toastTimeout}
          onChange={setToastTimeout}
          min={1000}
          max={60000}
          step={500}
          suffix="ms"
        />
      </Field>
    </div>
  );
}
