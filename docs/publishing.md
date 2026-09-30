# Publishing the maintained fork

The package is `@hypn4/chappie`, maintained in `hypn4/chappie`. Retain the
upstream MIT attribution, `chappie/chatgpt` provider, and `chappie-omp`
executable. Development, installation verification, builds, tests, and packing
use Bun. GitHub Actions publishes releases with npm Trusted Publishing (OIDC),
without a local npm login or a stored publishing token. Published versions are
immutable.

`package.json` commits the release channel as `publishConfig.tag`: `latest`
for the default installation, or `next` for an opt-in preview. A version such
as `X.Y.Z-rc.N` remains a prerelease regardless of its npm channel. Select the
channel before publishing instead of moving tags afterward.

## Bun toolchain

The repository pins Bun in `.bun-version`, declares the same version in
`packageManager`, and commits the text `bun.lock`. Use `bun ci` for
reproducible CI installs; it fails when `package.json` and the lockfile differ.
`bunfig.toml` uses Bun Shell for cross-platform package scripts and applies a
three-day minimum-release-age policy to newly resolved packages. Frozen
`bun.lock` installs remain reproducible without weakening that gate for future OMP releases.

Bun's default-secure lifecycle policy is retained. Only dependencies whose
installation scripts are required by this dependency graph are listed in
`trustedDependencies`.

## Verification pipeline

`check.yml` is reused by pull requests, releases, and npm publishing:

1. Install from `bun.lock` with `bun ci` on Linux, macOS, and Windows.
2. Run source checks, the Bun test suite, native OMP integration, and the
   otunnel protocol compatibility suite on all three operating systems.
3. Verify the declared OMP 18.3 compatibility floor in a separate Linux job.
4. Build one tarball on Linux with `bun run build` followed by
   `bun pm pack --ignore-scripts`, then upload it as `npm-package`.
5. Download those exact bytes on all three operating systems, install them in a
   clean consumer with `bun add --ignore-scripts`, add the pinned OMP runtime
   used by the checkout integration suite, start the installed broker, and run
   the packaged OMP integration suite. Each consumer verifies the archive's
   SHA-512 integrity.

The maintained tunnel compatibility baseline is `otunnel 0.2.x`. Run
`bun run test:otunnel` to verify an installed 0.2 runtime and Chappie's
`openai/session`, `otunnel/requestId`, and duplicate-request contracts. The
runtime check is skipped when `otunnel` is not installed, while protocol
regressions still run.

For a local package check, choose a new, empty directory outside the checkout:

```sh
bun ci
bun run check
bun run test:omp
bun run test:otunnel
bun run build
bun pm pack --ignore-scripts --filename package.tgz
bun scripts/verify-package.mjs package.tgz --prepare /path/to/empty-consumer
cd /path/to/empty-consumer
bun add --ignore-scripts /path/to/chappie/package.tgz
bun add --ignore-scripts @oh-my-pi/pi-coding-agent@18.4.4
cd /path/to/chappie
bun scripts/verify-package.mjs package.tgz --installed /path/to/empty-consumer --omp
```

Git checkout tests and package checks serve different purposes; never replace
the package install with a link to source dependencies.

After publishing, verify the README's `bun x` command with MCP stdin kept
open, then confirm `omp plugin install @hypn4/chappie` and the explicit
`@latest` form select the intended release. The broker and plugin are
installed separately and should use the same version.

## npm Trusted Publishing boundary

Bun owns dependency installation, build, test, pack, and consumer validation.
The publish job retains `actions/setup-node` and `npm publish` only for the
final npm registry write because Bun's current publishing documentation does
not document an equivalent npm Trusted Publishing/OIDC exchange. Replacing that
step with a long-lived npm token would reduce security, so this boundary remains
intentionally narrow.

This fork is configured for `hypn4/chappie`, workflow `publish.yml`,
environment `release`, and repository variable
`NPM_TRUSTED_PUBLISHING=true`. The publish job verifies npm 11.5.1 or newer,
the minimum client version for Trusted Publishing. Only this final job has
`id-token: write`; it receives the already-tested tarball and does not rebuild
or install source dependencies.

For a new package or repository, follow npm's Trusted Publishers setup guide.
Do not add a bypass-2FA token or automate browser/account approvals.

## Subsequent releases

Commit the new version and intended `publishConfig.tag` to `main`, then push
its exact `v<version>` tag. `release.yml` reuses the verification pipeline
and creates a draft GitHub Release. Publishing that draft triggers
`publish.yml`. Alternatively, run `publish.yml` with an existing,
unpublished tag and `dry_run=false`.

The workflow requires the tagged commit to belong to `main` and validates its
committed channel. The release environment publishes the exact verified
artifact once with `npm publish --tag`. OIDC availability is checked before
the write, no `NPM_TOKEN` is stored, and provenance is generated by npm.

There is no post-publish `npm dist-tag add` step. A repeated publication of an
existing version fails normally. Do not overwrite, unpublish, silently accept
different bytes, or change versions to hide a failed check. Keep Beads data,
local settings, and credentials out of Git and the tarball.

## References

- [Bun package manager](https://bun.sh/docs/pm)
- [Bun installs and `bun ci`](https://bun.sh/docs/pm/cli/install)
- [Bun lifecycle scripts](https://bun.sh/docs/pm/lifecycle)
- [setup-bun](https://github.com/oven-sh/setup-bun)
- [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
- [Workflow artifacts](https://docs.github.com/en/actions/tutorials/store-and-share-data)
