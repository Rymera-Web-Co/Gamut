//! Repo-wide find & replace. A ripgrep-style walk (the `ignore` crate) over the
//! active repo's working tree, matched with the `regex` crate so the
//! case-sensitive / whole-word / regex toggles all share one engine. Results are
//! grouped by file with per-line previews and capped so a huge repo can't flood
//! the renderer; replace re-applies the same pattern to a caller-chosen subset
//! of lines.
//!
//! Per-file (in-editor) find is handled entirely by Monaco on the frontend — the
//! backend only owns the cross-file work, mirroring `files.rs`'s IPC shape.

use std::collections::HashSet;
use std::fs;
use std::path::Path;

use ignore::overrides::OverrideBuilder;
use ignore::WalkBuilder;
use regex::{NoExpand, Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::files::safe_join;
use crate::commands::history::repo_path;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// Files larger than this are skipped — searching/replacing megabytes inline
/// isn't worth blocking on, and matches the editor's own read cap.
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// Stop after this many matching files so a broad query stays responsive.
const MAX_FILES: usize = 1000;
/// Stop after this many total matches across the whole repo.
const MAX_TOTAL_MATCHES: usize = 5000;
/// Cap matching lines per file (one line can still hold several matches).
const MAX_LINES_PER_FILE: usize = 1000;
/// Longest line preview returned to the UI; longer lines are cut on a char
/// boundary and flagged so the renderer can show an ellipsis.
const MAX_PREVIEW_BYTES: usize = 1000;

/// The shared query shape for both search and replace. Sent from the frontend
/// in camelCase. `includes`/`excludes` are gitignore-style globs (e.g. `src/**`,
/// `*.rs`); empty `includes` means "everything not excluded".
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchQuery {
    pub query: String,
    pub is_regex: bool,
    pub case_sensitive: bool,
    pub whole_word: bool,
    #[serde(default)]
    pub includes: Vec<String>,
    #[serde(default)]
    pub excludes: Vec<String>,
    /// Include files ignored by `.gitignore` / excludes when set.
    pub include_ignored: bool,
}

/// A single match's span within a line preview, as UTF-16 offsets so the
/// frontend can slice the JS string directly for highlighting.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchRange {
    pub start: u32,
    pub end: u32,
}

/// One matching line: its 1-based number, the (possibly truncated) text, and
/// every match span on it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineHit {
    pub line: u32,
    pub preview: String,
    pub matches: Vec<MatchRange>,
    pub preview_truncated: bool,
}

/// All matches within one file, repo-relative path with forward slashes.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHits {
    pub path: String,
    pub hits: Vec<LineHit>,
    pub match_count: u32,
    /// Hit `MAX_LINES_PER_FILE` — there are more matches than returned.
    pub truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    pub files: Vec<FileHits>,
    pub total_matches: u32,
    pub files_with_matches: u32,
    /// Hit a global cap (`MAX_FILES` / `MAX_TOTAL_MATCHES`); results are partial.
    pub truncated: bool,
}

/// One file's replace selection: the 1-based line numbers whose matches should
/// be replaced. Lines absent here are left untouched (per-file / per-line
/// opt-out), so the applied change matches what the user kept in the preview.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceTarget {
    pub path: String,
    pub lines: Vec<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedFile {
    pub path: String,
    pub reason: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceResult {
    pub files_changed: u32,
    pub replacements: u32,
    /// Files that couldn't be replaced (binary/oversized/non-UTF-8/gone), so the
    /// UI can report them instead of silently dropping them.
    pub skipped: Vec<SkippedFile>,
}

/// Compile the query into a regex, honoring the literal/regex, case, and
/// whole-word toggles. Empty queries are rejected up front.
fn build_regex(q: &SearchQuery) -> AppResult<Regex> {
    if q.query.is_empty() {
        return Err(AppError::Other("empty search query".into()));
    }
    let mut pattern = if q.is_regex {
        q.query.clone()
    } else {
        regex::escape(&q.query)
    };
    if q.whole_word {
        pattern = format!(r"\b(?:{pattern})\b");
    }
    RegexBuilder::new(&pattern)
        .case_insensitive(!q.case_sensitive)
        .build()
        .map_err(|e| AppError::Other(format!("invalid search pattern: {e}")))
}

/// Build the gitignore-aware walker with the include/exclude glob overrides.
fn build_walk(root: &Path, q: &SearchQuery) -> AppResult<ignore::Walk> {
    let mut ob = OverrideBuilder::new(root);
    for inc in &q.includes {
        let inc = inc.trim();
        if !inc.is_empty() {
            ob.add(inc)
                .map_err(|e| AppError::Other(format!("bad include glob '{inc}': {e}")))?;
        }
    }
    // Excludes are negated globs; in an Override they take precedence over the
    // positive includes, matching the usual "include X but not Y" intent.
    for exc in &q.excludes {
        let exc = exc.trim();
        if !exc.is_empty() {
            ob.add(&format!("!{exc}"))
                .map_err(|e| AppError::Other(format!("bad exclude glob '{exc}': {e}")))?;
        }
    }
    let overrides = ob
        .build()
        .map_err(|e| AppError::Other(format!("invalid glob filters: {e}")))?;

    let respect_ignores = !q.include_ignored;
    let mut wb = WalkBuilder::new(root);
    wb.overrides(overrides)
        // Show dotfiles by default (the file tree does too); `.git` is dropped
        // explicitly below so we never descend into it.
        .hidden(false)
        .git_ignore(respect_ignores)
        .git_global(respect_ignores)
        .git_exclude(respect_ignores)
        .ignore(respect_ignores)
        .parents(respect_ignores)
        .require_git(false)
        .filter_entry(|e| e.file_name() != ".git");
    Ok(wb.build())
}

/// UTF-16 code-unit offset of `byte_idx` within `s`, so spans line up with how
/// JavaScript indexes the same string.
fn utf16_offset(s: &str, byte_idx: usize) -> u32 {
    s[..byte_idx].encode_utf16().count() as u32
}

/// Read a file as searchable text, returning `None` for anything we won't touch:
/// non-files, oversized, binary (NUL in the first chunk), or non-UTF-8.
fn read_searchable(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    let sample = &bytes[..bytes.len().min(8192)];
    if sample.contains(&0) {
        return None;
    }
    String::from_utf8(bytes).ok()
}

/// Find every match on one line, returning a hit (preview + spans) or `None`.
/// Zero-width matches are skipped so patterns like `a*` don't emit noise.
fn line_hit(re: &Regex, line: &str, line_no: u32) -> Option<LineHit> {
    let mut raw: Vec<(usize, usize)> = Vec::new();
    for m in re.find_iter(line) {
        if m.start() != m.end() {
            raw.push((m.start(), m.end()));
        }
        // A pathological line shouldn't produce thousands of spans.
        if raw.len() >= 500 {
            break;
        }
    }
    if raw.is_empty() {
        return None;
    }

    // Cap the preview on a char boundary; drop spans that fall past the cut.
    let mut cut = line.len();
    let mut truncated = false;
    if line.len() > MAX_PREVIEW_BYTES {
        cut = MAX_PREVIEW_BYTES;
        while !line.is_char_boundary(cut) {
            cut -= 1;
        }
        truncated = true;
    }

    let matches: Vec<MatchRange> = raw
        .iter()
        .filter(|(s, _)| *s < cut)
        .map(|&(s, e)| MatchRange {
            start: utf16_offset(line, s),
            end: utf16_offset(line, e.min(cut)),
        })
        .collect();
    if matches.is_empty() {
        return None;
    }

    Some(LineHit {
        line: line_no,
        preview: line[..cut].to_string(),
        matches,
        preview_truncated: truncated,
    })
}

/// Core search over a working-tree root — split out from the command so it's
/// testable without a live `AppState`.
fn search_root(root: &Path, q: &SearchQuery) -> AppResult<SearchResults> {
    let re = build_regex(q)?;
    let walk = build_walk(root, q)?;

    let mut files: Vec<FileHits> = Vec::new();
    let mut total: u32 = 0;
    let mut truncated = false;

    'walk: for dent in walk {
        let Ok(dent) = dent else { continue };
        if !dent.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let path = dent.path();
        let Some(text) = read_searchable(path) else {
            continue;
        };

        let mut hits: Vec<LineHit> = Vec::new();
        let mut file_count: u32 = 0;
        let mut file_trunc = false;
        for (i, line) in text.lines().enumerate() {
            if let Some(hit) = line_hit(&re, line, (i + 1) as u32) {
                file_count += hit.matches.len() as u32;
                hits.push(hit);
                if hits.len() >= MAX_LINES_PER_FILE {
                    file_trunc = true;
                    break;
                }
            }
        }
        if hits.is_empty() {
            continue;
        }

        let rel = path
            .strip_prefix(root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        total += file_count;
        files.push(FileHits {
            path: rel,
            hits,
            match_count: file_count,
            truncated: file_trunc,
        });

        if files.len() >= MAX_FILES || total as usize >= MAX_TOTAL_MATCHES {
            truncated = true;
            break 'walk;
        }
    }

    files.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    let files_with_matches = files.len() as u32;
    Ok(SearchResults {
        files,
        total_matches: total,
        files_with_matches,
        truncated,
    })
}

/// Replace every match on the selected `lines` of `text`, preserving line
/// endings (incl. CRLF and a missing final newline). Returns the rewritten text
/// and the number of matches replaced. In literal mode the replacement is taken
/// verbatim (`$` is not special); in regex mode `$1`/`${name}` expand.
fn apply_replacements(
    re: &Regex,
    text: &str,
    replacement: &str,
    is_regex: bool,
    lines: &HashSet<u32>,
) -> (String, u32) {
    let mut out = String::with_capacity(text.len());
    let mut count: u32 = 0;
    let mut line_no: u32 = 0;

    for segment in text.split_inclusive('\n') {
        line_no += 1;
        // Peel the line terminator so matching sees the same content `lines()`
        // (and therefore the search) did, then re-attach it untouched.
        let (body, nl) = match segment.strip_suffix('\n') {
            Some(b) => (b, "\n"),
            None => (segment, ""),
        };
        let (content, cr) = match body.strip_suffix('\r') {
            Some(c) => (c, "\r"),
            None => (body, ""),
        };

        if lines.contains(&line_no) {
            let mut last = 0usize;
            for m in re.find_iter(content) {
                if m.start() == m.end() {
                    continue;
                }
                out.push_str(&content[last..m.start()]);
                if is_regex {
                    out.push_str(&re.replace(m.as_str(), replacement));
                } else {
                    out.push_str(&re.replace(m.as_str(), NoExpand(replacement)));
                }
                last = m.end();
                count += 1;
            }
            out.push_str(&content[last..]);
        } else {
            out.push_str(content);
        }
        out.push_str(cr);
        out.push_str(nl);
    }

    (out, count)
}

/// Core replace over a root — testable without `AppState`.
fn replace_root(
    root: &Path,
    q: &SearchQuery,
    replacement: &str,
    targets: &[ReplaceTarget],
) -> AppResult<ReplaceResult> {
    let re = build_regex(q)?;
    let mut files_changed = 0u32;
    let mut replacements = 0u32;
    let mut skipped: Vec<SkippedFile> = Vec::new();

    for target in targets {
        if target.lines.is_empty() {
            continue;
        }
        let path = match safe_join(root, &target.path) {
            Ok(p) => p,
            Err(e) => {
                skipped.push(SkippedFile {
                    path: target.path.clone(),
                    reason: e.to_string(),
                });
                continue;
            }
        };
        let Some(text) = read_searchable(&path) else {
            skipped.push(SkippedFile {
                path: target.path.clone(),
                reason: "skipped (binary, too large, or not UTF-8)".into(),
            });
            continue;
        };

        let lines: HashSet<u32> = target.lines.iter().copied().collect();
        let (new_text, n) = apply_replacements(&re, &text, replacement, q.is_regex, &lines);
        if n == 0 {
            continue;
        }
        if let Err(e) = fs::write(&path, new_text) {
            skipped.push(SkippedFile {
                path: target.path.clone(),
                reason: format!("write failed: {e}"),
            });
            continue;
        }
        files_changed += 1;
        replacements += n;
    }

    Ok(ReplaceResult {
        files_changed,
        replacements,
        skipped,
    })
}

/// Search the active repo's working tree for `query`, grouped by file. Honors
/// `.gitignore` (unless `include_ignored`) and the include/exclude globs.
#[tauri::command]
pub fn search_repo(
    state: State<AppState>,
    repo_id: i64,
    query: SearchQuery,
) -> AppResult<SearchResults> {
    let root = repo_path(&state, repo_id)?;
    search_root(&root, &query)
}

/// Apply `replacement` to the chosen matches across files. `targets` carries the
/// post-opt-out selection (which lines in which files), so the write matches the
/// preview the user approved. Binary/oversized/non-UTF-8 files are reported in
/// `skipped` rather than failing the whole batch.
#[tauri::command]
pub fn replace_in_files(
    state: State<AppState>,
    repo_id: i64,
    query: SearchQuery,
    replacement: String,
    targets: Vec<ReplaceTarget>,
) -> AppResult<ReplaceResult> {
    let root = repo_path(&state, repo_id)?;
    replace_root(&root, &query, &replacement, &targets)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query(q: &str) -> SearchQuery {
        SearchQuery {
            query: q.into(),
            is_regex: false,
            case_sensitive: false,
            whole_word: false,
            includes: vec![],
            excludes: vec![],
            include_ignored: false,
        }
    }

    #[test]
    fn literal_match_is_case_insensitive_by_default() {
        let re = build_regex(&query("foo")).unwrap();
        let hit = line_hit(&re, "Foo and FOO", 1).unwrap();
        assert_eq!(hit.matches.len(), 2);
        assert_eq!((hit.matches[0].start, hit.matches[0].end), (0, 3));
        assert_eq!((hit.matches[1].start, hit.matches[1].end), (8, 11));
    }

    #[test]
    fn case_sensitive_toggle_narrows_matches() {
        let mut q = query("foo");
        q.case_sensitive = true;
        let re = build_regex(&q).unwrap();
        assert!(line_hit(&re, "Foo FOO", 1).is_none());
        assert_eq!(line_hit(&re, "foo Foo", 1).unwrap().matches.len(), 1);
    }

    #[test]
    fn whole_word_does_not_match_substrings() {
        let mut q = query("cat");
        q.whole_word = true;
        let re = build_regex(&q).unwrap();
        assert!(line_hit(&re, "concatenate", 1).is_none());
        assert_eq!(line_hit(&re, "the cat sat", 1).unwrap().matches.len(), 1);
    }

    #[test]
    fn literal_special_chars_are_escaped() {
        // In literal mode `.` is a literal dot, not "any char".
        let re = build_regex(&query("a.c")).unwrap();
        assert!(line_hit(&re, "abc", 1).is_none());
        assert_eq!(line_hit(&re, "a.c", 1).unwrap().matches.len(), 1);
    }

    #[test]
    fn ranges_use_utf16_offsets() {
        // "é" is one UTF-16 unit but two UTF-8 bytes; offsets must be UTF-16.
        let re = build_regex(&query("x")).unwrap();
        let hit = line_hit(&re, "éx", 1).unwrap();
        assert_eq!((hit.matches[0].start, hit.matches[0].end), (1, 2));
    }

    #[test]
    fn replace_only_selected_lines() {
        let re = build_regex(&query("foo")).unwrap();
        let text = "foo\nfoo\nfoo\n";
        let lines: HashSet<u32> = [1, 3].into_iter().collect();
        let (out, n) = apply_replacements(&re, text, "bar", false, &lines);
        assert_eq!(n, 2);
        assert_eq!(out, "bar\nfoo\nbar\n");
    }

    #[test]
    fn replace_preserves_crlf_and_missing_final_newline() {
        let re = build_regex(&query("a")).unwrap();
        let text = "a\r\nb\r\na"; // CRLF, no trailing newline on the last line
        let lines: HashSet<u32> = [1, 3].into_iter().collect();
        let (out, n) = apply_replacements(&re, text, "z", false, &lines);
        assert_eq!(n, 2);
        assert_eq!(out, "z\r\nb\r\nz");
    }

    #[test]
    fn literal_replacement_treats_dollar_verbatim() {
        let re = build_regex(&query("PRICE")).unwrap();
        let lines: HashSet<u32> = [1].into_iter().collect();
        let (out, n) = apply_replacements(&re, "PRICE", "$5", false, &lines);
        assert_eq!(n, 1);
        assert_eq!(out, "$5");
    }

    #[test]
    fn regex_replacement_expands_capture_groups() {
        let mut q = query(r"(\w+)=(\d+)");
        q.is_regex = true;
        let re = build_regex(&q).unwrap();
        let lines: HashSet<u32> = [1].into_iter().collect();
        let (out, n) = apply_replacements(&re, "x=1", "$2=$1", true, &lines);
        assert_eq!(n, 1);
        assert_eq!(out, "1=x");
    }

    #[test]
    fn walk_respects_gitignore_and_globs() {
        let root = std::env::temp_dir().join(format!("gamut_search_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("build")).unwrap();
        std::fs::write(root.join(".gitignore"), "build/\n").unwrap();
        std::fs::write(root.join("src/a.rs"), "needle here\n").unwrap();
        std::fs::write(root.join("src/b.txt"), "needle there\n").unwrap();
        std::fs::write(root.join("build/c.rs"), "needle ignored\n").unwrap();

        // Default: gitignored build/ is excluded; both src files match.
        let res = search_root(&root, &query("needle")).unwrap();
        assert_eq!(res.files_with_matches, 2);
        assert!(res.files.iter().all(|f| !f.path.starts_with("build/")));

        // Include glob narrows to *.rs.
        let mut q = query("needle");
        q.includes = vec!["*.rs".into()];
        let res = search_root(&root, &q).unwrap();
        assert_eq!(res.files_with_matches, 1);
        assert_eq!(res.files[0].path, "src/a.rs");

        // include_ignored surfaces the build/ file too.
        let mut q = query("needle");
        q.include_ignored = true;
        let res = search_root(&root, &q).unwrap();
        assert_eq!(res.files_with_matches, 3);

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn binary_files_are_skipped() {
        let root =
            std::env::temp_dir().join(format!("gamut_search_bin_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("text.txt"), "needle\n").unwrap();
        std::fs::write(root.join("blob.bin"), b"need\0le\n").unwrap();

        let res = search_root(&root, &query("need")).unwrap();
        assert_eq!(res.files_with_matches, 1);
        assert_eq!(res.files[0].path, "text.txt");

        std::fs::remove_dir_all(&root).unwrap();
    }
}
