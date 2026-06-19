import type { CommitRow } from "@/lib/ipc";
import { graphColor } from "@/lib/format";

export const ROW_HEIGHT = 40;
export const COL_WIDTH = 16;

function cx(col: number) {
  return col * COL_WIDTH + COL_WIDTH / 2;
}

/** Renders one commit row's graph cell: connecting lanes + the commit node. */
export function CommitGraph({ row, width }: { row: CommitRow; width: number }) {
  const svgWidth = Math.max(width, 1) * COL_WIDTH;
  const h = ROW_HEIGHT;

  return (
    <svg width={svgWidth} height={h} className="shrink-0" style={{ display: "block" }}>
      {row.paths.map((p, i) => {
        const x1 = cx(p.from_col);
        const x2 = cx(p.to_col);
        const y1 = p.from_y * h;
        const y2 = p.to_y * h;
        const color = graphColor(p.color);
        const d =
          x1 === x2
            ? `M ${x1} ${y1} L ${x2} ${y2}`
            : `M ${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}`;
        return <path key={i} d={d} stroke={color} strokeWidth={1.5} fill="none" />;
      })}
      <circle
        cx={cx(row.node_col)}
        cy={h / 2}
        r={4}
        fill={graphColor(row.color)}
        stroke="var(--color-background)"
        strokeWidth={1.5}
      />
    </svg>
  );
}
