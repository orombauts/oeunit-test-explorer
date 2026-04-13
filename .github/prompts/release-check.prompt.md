---
description: "Pre-publish release checklist for oeunit-test-explorer. Run before every npm publish or vsce publish."
agent: "agent"
---

You are performing a pre-publish release validation for the `oeunit-test-explorer` VS Code extension. Work through every step below in order, report findings concisely, and flag any issues with ❌ before allowing the user to proceed.

## 1. Verify version consistency
- Read [package.json](../../package.json) and note `version`.
- Read [package-lock.json](../../package-lock.json) — both the root `version` and the `packages[""].version` must match `package.json`.
- Read [CHANGELOG.md](../../CHANGELOG.md) — the top-most `## [x.y.z]` heading must match and must **not** be `[Unreleased]`.
- Check that the local git tag exists: run `git tag --list` and confirm `v<version>` is present.
- Check that the commit and tag are pushed: run `git log origin/main..HEAD --oneline` (should be empty) and `git ls-remote --tags origin v<version>` (should return a line).

## 2. Confirm clean working tree
- Run `git status --short`. The output should be empty (no uncommitted changes).

## 3. Clean build
- Delete the entire `out/` directory: run `Remove-Item out\* -Recurse -Force` (Windows) or `rm -rf out/` (Linux/macOS).
- Run `npm run compile` (`tsc -p ./`). Must exit 0 with no errors.
- Verify that `out/` contains **only** files that correspond to current source files in `src/` — no stale `.js` or `.js.map` files from deleted or renamed source files should be present.

## 4. Lint
- Run `npm run lint`. Must exit 0.

## 5. Verify CHANGELOG entry quality
- The `[x.y.z]` section in [CHANGELOG.md](../../CHANGELOG.md) should have at least one subsection (`### Added`, `### Fixed`, or `### Changed`) with meaningful bullet points — not just chore/docs entries.

## 6. Package dry-run
- Run `npx vsce package --no-git-tag-version 2>&1`. Check that it prints `Packaged:` and produces a `.vsix` file. Report the file name and size.

## 7. Summary
After all checks, print a final table:

| Check | Status |
|-------|--------|
| Version consistency | ✅ / ❌ |
| Clean working tree | ✅ / ❌ |
| Clean build (no stale out/ files) | ✅ / ❌ |
| Lint | ✅ / ❌ |
| CHANGELOG quality | ✅ / ❌ |
| Package dry-run | ✅ / ❌ |
| Tag pushed to origin | ✅ / ❌ |

Only if **all checks pass**, print:
> ✅ Safe to run `npm run publish`.

Otherwise list what must be fixed first.
