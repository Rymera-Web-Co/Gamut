import { Divider, Field, PanelTitle, Segmented, useSetting } from "../controls";

export function DiffPanel() {
  const [diffLayout, setDiffLayout] = useSetting("diffLayout");
  const [reviewMode, setReviewMode] = useSetting("reviewMode");

  return (
    <div>
      <PanelTitle>Diff &amp; Review</PanelTitle>
      <Field label="Default diff layout">
        <Segmented
          value={diffLayout}
          onChange={setDiffLayout}
          options={[
            { value: "side-by-side", label: "Side by side" },
            { value: "unified", label: "Unified" },
          ]}
        />
      </Field>
      <Divider />
      <Field label="Default review mode" hint="Which view a repository's Review tab opens in.">
        <Segmented
          value={reviewMode}
          onChange={setReviewMode}
          options={[
            { value: "working", label: "Working tree" },
            { value: "branch", label: "Branch vs base" },
          ]}
        />
      </Field>
    </div>
  );
}
