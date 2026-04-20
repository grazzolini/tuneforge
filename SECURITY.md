# Security Policy

## Supported Versions

Tuneforge is pre-1.0 and ships from `main`. Only the latest commit on `main` receives security fixes.

## Threat Model

Tuneforge is a **local-only desktop application**. The backend binds to `127.0.0.1` and is intended to be reached only by the bundled Tauri shell on the same machine. There is **no authentication or authorization** by design — the loopback bind is the trust boundary.

**Do not** expose the backend port to a network, run it on a multi-user host without isolation, or place it behind a reverse proxy reachable from outside the machine. Doing so removes every assumption this project relies on.

In scope for security reports:

- Path traversal, command injection, or arbitrary file read/write through the local API
- Tauri sandbox or capability escapes
- Supply-chain issues (compromised dependencies, malicious build artifacts)
- Secrets accidentally committed to the repository
- CI workflow weaknesses that could leak `GITHUB_TOKEN` or repo write access

Out of scope:

- Lack of authentication on the loopback API (intentional)
- Information disclosure to processes already running on the same user account
- Denial of service via unbounded local job submission (single-user tool)

## Reporting a Vulnerability

Please **do not** open a public issue for security problems.

- Use GitHub's private vulnerability reporting: <https://github.com/grazzolini/tuneforge/security/advisories/new>
- Or email the maintainer directly (see the GitHub profile for `@grazzolini`).

Include:

1. A description of the issue and its impact.
2. Steps to reproduce, ideally with a minimal proof of concept.
3. Affected commit SHA or tag.
4. Any suggested mitigation.

You can expect an initial response within a few days. There is no bounty program.
