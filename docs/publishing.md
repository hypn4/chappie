# Publishing the maintained fork

The package is `@hypn4/chappie`, maintained in `hypn4/chappie`. Retain the upstream
MIT attribution, `chappie/chatgpt` provider, and `chappie-omp` executable.
GitHub Actions publishes releases with npm trusted publishing (OIDC), without a
local npm login or a stored publishing token. Published versions are immutable.

`package.json` commits the release channel as `publishConfig.tag`: `latest` for
the default installation, or `next` for an opt-in preview. This fork currently
selects `latest`, including release candidates. A version such as `X.Y.Z-rc.N`
remains a prerelease regardless of its npm channel; `latest` is not a stability
claim. Select the channel before publishing instead of moving tags afterward.

## Verification pipeline

`check.yml` is reused by pull requests, releases, and npm publishing:

1. Check the source on Linux, macOS, and Windows using the frozen pnpm lockfile.
2. Build one tarball on Linux and upload it as `npm-package`.
3. Download those exact bytes on all three operating systems, install them in
   clean consumer projects using ordinary `npm install`, and start the installed
   JavaScript broker. Each consumer compares the archive's SHA-512 integrity.

Node and npm come only from `actions/setup-node`, using `.node-version`.
`pnpm/setup` installs only pnpm: automatic runtime detection and dependency
installation are disabled. Consumer jobs do not install pnpm or inherit a build
job's environment. No script searches for npm internals or invokes Windows shims.
The installer runs as its own Actions step with npm timing logs retained on failure.
A timeout is a failed check, not an accepted installation.

The maintained tunnel compatibility baseline is `otunnel 0.2.x`. Run
`pnpm test:otunnel` to verify an installed 0.2 runtime and Chappie's
`openai/session`, `otunnel/requestId`, and duplicate-request contracts.
The runtime check is skipped when `otunnel` is not installed, while the
protocol regressions still run. A new otunnel minor line is not assumed
compatible until this check and the package/OMP suites pass.

For a local check, choose a new, empty directory outside the checkout. These
commands work in a shell with Node, npm, pnpm, and tar on PATH:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm pack --out package.tgz
node scripts/verify-package.mjs package.tgz --prepare /path/to/empty-consumer
npm install ./package.tgz --prefix /path/to/empty-consumer --ignore-scripts --omit=dev --no-audit --no-fund
node scripts/verify-package.mjs package.tgz --installed /path/to/empty-consumer
```

With OMP on PATH, add `--omp` to the last command to test the packaged extension
in an isolated OMP session without model inference. Remove only your temporary
consumer directory afterward. Git checkout tests and package checks serve different
purposes; never replace the package install with a link to source dependencies.

After publishing, verify the README's `npx` and `bun x` commands with MCP stdin
kept open (`bunx` is the equivalent alias when available), then confirm
`omp plugin install @hypn4/chappie` and the explicit
`@latest` form select the intended release. The broker and plugin are installed
separately and should use the same version. No fork of OMP is required.

## One-time trusted publisher setup

This fork is already configured for `hypn4/chappie`, workflow `publish.yml`,
environment `release`, with direct `npm publish` allowed and repository variable
`NPM_TRUSTED_PUBLISHING=true`. Do not repeat npm login, trust management, or account
verification for routine releases. Account 2FA remains enabled.

For a new package or repository, follow the [npm setup guide](https://docs.npmjs.com/trusted-publishers/).
The package must exist before configuring its trusted publisher. Initial package
creation and trust/account changes may require interactive authentication; those
are setup operations, not release steps. Keep the workflow filename and environment
aligned with the trust configuration. Do not add a bypass-2FA token or change to
stage-only publication to automate direct releases: stage approval is interactive.

## Subsequent releases

Commit the new version and intended `publishConfig.tag` to `main`, then push its
exact `v<version>` tag. `release.yml` verifies the package and creates a draft
GitHub Release. Publishing that draft triggers `publish.yml` automatically; this
GitHub release decision does not require npm authentication. Alternatively, run
`publish.yml` with an existing, unpublished tag and `dry_run=false`.

The workflow requires the tagged commit to belong to `main` and validates its
committed channel. After all source and consumer checks pass, the `release`
environment job publishes the verified artifact once with `npm publish --tag`
using that channel. Only this job has `id-token: write`. It checks that GitHub
OIDC is available, uses no `NPM_TOKEN`, and neither rebuilds nor installs source
dependencies. Provenance is generated automatically.

There is no post-publish `npm dist-tag add` step. OIDC supports publishing, not
arbitrary registry administration. In particular, it does not authenticate a
separate `dist-tag` or `trust` command, and `npm whoami` is not an OIDC preflight.
Publishing to `latest` updates the version used by `omp plugin install
@hypn4/chappie` and `@latest` in the same operation. `next` remains the last
explicit preview; the two aliases are not synchronized after each release.

To move a preview into the normal release stream, publish a new release version
to `latest`. Do not republish an existing version or automate browser approvals.

A repeated publication of an existing version fails normally. Do not overwrite,
unpublish, silently accept different bytes, or change versions to hide a failed
check. Source checks and consumer installation must all pass before publishing.
Keep Beads data, local settings, and credentials out of Git and the tarball.

## References

- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
- [setup-node advanced usage](https://github.com/actions/setup-node/blob/main/docs/advanced-usage.md)
- [pnpm CI](https://pnpm.io/continuous-integration)
- [pnpm setup inputs](https://github.com/pnpm/setup/blob/main/action.yml)
- [Workflow artifacts](https://docs.github.com/en/actions/tutorials/store-and-share-data)
- [npm tarball installation](https://docs.npmjs.com/cli/v11/commands/npm-install/)
