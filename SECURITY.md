# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in Gamut, please report it **privately** so it
can be addressed before public disclosure.

Use GitHub's [private vulnerability reporting](https://github.com/Rymera-Web-Co/Gamut/security/advisories/new)
to open a report.

Please include:

- A description of the issue and its potential impact.
- Steps to reproduce, or a proof of concept.
- The version / commit of Gamut and your operating system.

We'll acknowledge your report as soon as we can and keep you updated on the fix. Please
give us a reasonable window to release a patch before any public disclosure.

## Scope notes

A few things worth knowing about Gamut's security model:

- **Secrets** — GitHub tokens are stored in the OS keychain (via the `keyring` crate),
  never in the SQLite database or on disk in plaintext. The frontend never receives the
  raw token; all authenticated GitHub calls happen in the Rust backend.
- **Git operations** are performed by the Rust backend against local repositories you
  explicitly register. The frontend has no direct filesystem access.
- **Integrated terminal** — Gamut includes an opt-in per-repo/per-group terminal that
  spawns your real login shell (a PTY) rooted at the repo or bound folder. This is
  arbitrary local command execution with your user's privileges, by design — the same
  trust level as opening a terminal yourself. Sessions run only for repositories/folders
  you've registered, and are terminated when the repo is removed or the app is closed.
- **Network** — GitHub REST calls go out over `rustls` TLS.

Reports about the bundled third-party dependencies are welcome too; we track upstream
advisories and update as needed.
