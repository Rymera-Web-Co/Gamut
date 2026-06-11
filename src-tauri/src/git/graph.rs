use git2::Oid;
use serde::Serialize;

/// A single line segment within a commit row's cell, in normalized coordinates:
/// `x` is the lane/column index, `y` runs 0.0 (top) → 0.5 (node center) → 1.0 (bottom).
/// The frontend scales these by column width / row height and draws an SVG path.
#[derive(Serialize, Clone, Copy)]
pub struct GraphPath {
    pub from_col: usize,
    pub from_y: f32,
    pub to_col: usize,
    pub to_y: f32,
    pub color: usize,
}

#[derive(Serialize)]
pub struct GraphRow {
    pub node_col: usize,
    pub color: usize,
    pub paths: Vec<GraphPath>,
}

pub struct CommitNode {
    pub oid: Oid,
    pub parents: Vec<Oid>,
}

/// Assign each commit to a lane (column) and compute the connecting paths.
///
/// Commits must be supplied in display order (newest first, topologically
/// sorted). Lanes are tracked as "the oid each column is currently waiting
/// for"; a commit takes the first lane awaiting it (or a fresh one), its first
/// parent continues that lane, and additional parents branch into new lanes.
///
/// Returns the rows plus the total column width needed to render the graph.
pub fn layout(commits: &[CommitNode]) -> (Vec<GraphRow>, usize) {
    let mut lanes: Vec<Option<Oid>> = Vec::new();
    let mut rows: Vec<GraphRow> = Vec::with_capacity(commits.len());
    let mut max_col = 0usize;

    for c in commits {
        let oid = c.oid;

        // The commit's column: the first lane already waiting for it, otherwise
        // a freed lane, otherwise a brand-new column.
        let node_col = match lanes.iter().position(|l| *l == Some(oid)) {
            Some(i) => i,
            None => {
                let i = lanes
                    .iter()
                    .position(|l| l.is_none())
                    .unwrap_or(lanes.len());
                if i == lanes.len() {
                    lanes.push(None);
                }
                i
            }
        };

        let incoming = lanes.clone();
        let mut paths: Vec<GraphPath> = Vec::new();

        // Incoming lanes from the row above: either they converge into this
        // commit, or they pass straight through to the row below.
        for (i, lane) in incoming.iter().enumerate() {
            if let Some(o) = lane {
                if *o == oid {
                    paths.push(GraphPath {
                        from_col: i,
                        from_y: 0.0,
                        to_col: node_col,
                        to_y: 0.5,
                        color: i,
                    });
                } else {
                    paths.push(GraphPath {
                        from_col: i,
                        from_y: 0.0,
                        to_col: i,
                        to_y: 1.0,
                        color: i,
                    });
                }
            }
        }

        // Every lane that was waiting for this commit has now been resolved.
        for lane in lanes.iter_mut() {
            if *lane == Some(oid) {
                *lane = None;
            }
        }

        // First parent continues in the commit's own column.
        if let Some(p0) = c.parents.first() {
            lanes[node_col] = Some(*p0);
            paths.push(GraphPath {
                from_col: node_col,
                from_y: 0.5,
                to_col: node_col,
                to_y: 1.0,
                color: node_col,
            });
        } else {
            lanes[node_col] = None; // root commit — lane ends here
        }

        // Additional parents branch into existing or fresh lanes.
        for pk in c.parents.iter().skip(1) {
            let k = match lanes.iter().position(|l| *l == Some(*pk)) {
                Some(k) => k,
                None => {
                    let k = lanes
                        .iter()
                        .position(|l| l.is_none())
                        .unwrap_or(lanes.len());
                    if k == lanes.len() {
                        lanes.push(None);
                    }
                    lanes[k] = Some(*pk);
                    k
                }
            };
            paths.push(GraphPath {
                from_col: node_col,
                from_y: 0.5,
                to_col: k,
                to_y: 1.0,
                color: k,
            });
        }

        while matches!(lanes.last(), Some(&None)) {
            lanes.pop();
        }

        let row_max = node_col
            .max(incoming.len().saturating_sub(1))
            .max(lanes.len().saturating_sub(1));
        max_col = max_col.max(row_max);

        rows.push(GraphRow {
            node_col,
            color: node_col,
            paths,
        });
    }

    (rows, max_col + 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn oid(n: u8) -> Oid {
        let mut bytes = [0u8; 20];
        bytes[19] = n;
        Oid::from_bytes(&bytes).unwrap()
    }

    #[test]
    fn linear_history_stays_in_one_lane() {
        // C -> B -> A (newest first)
        let commits = vec![
            CommitNode {
                oid: oid(3),
                parents: vec![oid(2)],
            },
            CommitNode {
                oid: oid(2),
                parents: vec![oid(1)],
            },
            CommitNode {
                oid: oid(1),
                parents: vec![],
            },
        ];
        let (rows, width) = layout(&commits);
        assert_eq!(width, 1);
        assert!(rows.iter().all(|r| r.node_col == 0));
    }

    #[test]
    fn merge_commit_spawns_a_second_lane() {
        // M has two parents (P1, P2); P2 lives in a second lane.
        let commits = vec![
            CommitNode {
                oid: oid(10),
                parents: vec![oid(9), oid(8)],
            },
            CommitNode {
                oid: oid(9),
                parents: vec![oid(7)],
            },
            CommitNode {
                oid: oid(8),
                parents: vec![oid(7)],
            },
            CommitNode {
                oid: oid(7),
                parents: vec![],
            },
        ];
        let (rows, width) = layout(&commits);
        assert!(width >= 2, "a merge should use at least two lanes");
        // The merge row should emit a path that branches to a different column.
        assert!(rows[0].paths.iter().any(|p| p.to_col != rows[0].node_col));
    }
}
