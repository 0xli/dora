# Publishing `@decentnetwork/dora` to npm

Internal release checklist. Not shipped to consumers (excluded by
the package's `files` field and `.npmignore`).

## One-time setup

```bash
npm login                          # log in as the @decentnetwork org owner
npm whoami                         # confirm
npm access ls-packages --json | jq '.["@decentnetwork/dora"]'   # confirm publish rights
```

## Pre-publish checks

1. **Working tree clean.** Commit / stash anything in progress.
2. **CI green.** `npm test` + `npm run typecheck` both pass.
3. **Version bumped.** `npm version <patch|minor|major>` — this
   updates `package.json` and creates a `vX.Y.Z` tag.
4. **CHANGELOG** updated (if maintained).
5. **`@decentnetwork/peer` dep version** in `package.json` matches
   what's actually on npm. Bump the dep range if you depend on
   features in a newer SDK.

## Dry run (recommended every time)

```bash
npm pack --dry-run
```

Review the file list. **What MUST be in the tarball:**

- `dist/**/*.js`
- `dist/**/*.d.ts`
- `README.md`
- `LICENSE`
- `docs/INSTALL.md`
- `docs/CONFIGURATION.md`
- `package.json`

**What MUST NOT be in the tarball:**

- `src/` (source)
- `test/`
- `**/*.js.map` / `**/*.d.ts.map` (source maps)
- `docs/DESIGN.md` (internal)
- `tsconfig*.json` / `.eslintrc*` (dev tooling)
- Anything else under `.npmignore`

The `files` field in `package.json` is the authoritative whitelist;
`.npmignore` is a defensive backstop.

## Publish

```bash
npm publish
```

(Scoped package — the `publishConfig.access: public` in
`package.json` makes this work without `--access public`.)

## Post-publish

1. Push the version-bump commit + tag: `git push && git push --tags`
2. Optionally announce in the repo's Releases tab.
3. Verify install from a clean cache:
   ```bash
   cd /tmp && rm -rf test-install && mkdir test-install && cd test-install
   npm init -y
   npm install @decentnetwork/dora@latest
   ls node_modules/@decentnetwork/dora    # should match the file list above
   ```

## Yanking a bad release

```bash
npm deprecate @decentnetwork/dora@<version> "reason"
# or hard:
npm unpublish @decentnetwork/dora@<version>      # within 72h of publish only
```

Then publish a `+1` patch with the fix.

## See also

- The package's user-facing docs live at `docs/INSTALL.md` and
  `docs/CONFIGURATION.md` — those are shipped to consumers.
- `README.md` is also shipped.
