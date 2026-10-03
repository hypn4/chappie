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
three-day minimum-release-age policy to routine dependency resolution.
Maintained direct dependencies are exact-pinned. A deliberate same-day release
train update can bypass the age filter only for that lockfile refresh, for
example `bun update '@oh-my-pi/*' --minimum-release-age=0`; review the lock
diff, run `bun audit` and the full suite, and commit the resulting
`bun.lock`. CI always uses the frozen lockfile.

Bun's default-secure lifecycle policy is retained. Only dependencies whose
installation scripts are required by this dependency graph are listed in
`trustedDependencies`.

The tested OMP baseline is 18.5.0, selected by the three exact development pins
in `package.json` and installed through `bun.lock`. `bun scripts/omp-version.mjs`
checks that all three pins and installed packages agree, prints that version,
and exposes it as `version` when `GITHUB_OUTPUT` is set. Runtime CI and the clean
consumer use this selector rather than a second version literal or a global
`omp`. The supported peer minimum remains `^18.4.8`; updating the verification
baseline does not raise it or add a separate minimum-version test job.

## Verification pipeline

`check.yml` keeps only distinct verification paths:

1. Run `bun ci` and source checks on Linux and Windows. Windows also runs
   current native OMP integration in normal and forced-yield mode to cover
   platform-specific process and path behavior.
2. On Linux, run `bun audit --audit-level=high`, verify the manifest-selected
   OMP runtime in both modes, and exercise the real otunnel 0.2.0 release binary.
3. Build one tarball on Linux, verify its contents and SHA-512 integrity, then
   install those same bytes once in a clean Bun consumer with the same selected
   OMP runtime. Verify both normal and forced-yield execution without repacking.
4. Upload that verified tarball as `npm-package` for the release workflow.

The maintained tunnel compatibility baseline is `otunnel 0.2.x`. Local
`bun run test:otunnel` still skips only the binary check when otunnel is not
installed; CI downloads the pinned 0.2.0 release and therefore never skips the
runtime contract.

For a local package check, choose a new, empty directory outside the checkout:

```sh
bun ci
omp_version="$(bun scripts/omp-version.mjs)"
bun run check
bun run test:omp
bun run test:otunnel
bun run build
bun pm pack --ignore-scripts --filename package.tgz
bun scripts/verify-package.mjs package.tgz --prepare /path/to/empty-consumer
cd /path/to/empty-consumer
bun add --ignore-scripts /path/to/chappie/package.tgz
bun add --ignore-scripts "@oh-my-pi/pi-coding-agent@$omp_version"
cd /path/to/chappie
bun scripts/verify-package.mjs package.tgz --installed /path/to/empty-consumer --omp
CHAPPIE_VERIFY_CALL_WAIT_MS=1 bun scripts/verify-package.mjs package.tgz --installed /path/to/empty-consumer --omp
```

Source tests and package checks serve different purposes; the package consumer
uses the packed artifact rather than a checkout link.

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
recovers the immutable `npm-package` Actions artifact from the successful
release workflow, compares it byte-for-byte with the GitHub Release asset, and
publishes the verified artifact. Automatic runs use the exact triggering run ID
and SHA, not the newest run for a branch. The run's repository, workflow path,
event and successful conclusion are validated before artifact recovery. The
tag must still identify the checked-out commit and belong to `main`.
This job does not rebuild or rerun the source test matrix. Only this final job
has `id-token: write`; `contents: write` lets it publish the verified GitHub
Release after npm verification. The trusted publisher filename and environment
remain `publish.yml` and `release`.

For a new package or repository, follow npm's Trusted Publishers setup guide.
Do not add a bypass-2FA token or automate browser/account approvals.

## Subsequent releases

Commit the new version and intended `publishConfig.tag` to `main`, then push
its exact `v<version>` tag. No manual draft publication is required:

1. `release.yml` reuses the Linux/Windows/runtime/package verification pipeline
   and creates a draft GitHub Release containing the tested tarball.
2. Its successful tag-push completion triggers `publish.yml` through
   `workflow_run`. Failed, cancelled, fork and manually dispatched verification
   runs do not automatically publish.
3. `publish.yml` validates the exact upstream run/commit, compares its immutable
   Actions artifact to the draft asset, and publishes those bytes using npm OIDC.
4. It checks the registry's exact version, committed dist-tag and SHA-512 integrity,
   allowing bounded registry propagation, then publishes the GitHub draft.

Do not chain this through `release: published`: a release written using the
workflow's `GITHUB_TOKEN` is not a reliable way to trigger another workflow.
The completion event also preserves the existing npm trusted publisher identity
without a personal access token or reusable-workflow identity change.
`publish.yml` must be on the default branch before the release tag is pushed.

Manual `publish.yml` dispatch remains available for dry runs (the default) and
explicit recovery. It requires the same tag and draft/release artifact from a
successful `release.yml` run. Dry runs neither write npm nor publish the draft.
The verified Actions artifact is retained for 30 days; after expiry, rerun
release verification instead of bypassing artifact checks. Environment approval
rules and `NPM_TRUSTED_PUBLISHING` are still respected; no account or protection
configuration is changed by the workflow.

The release environment publishes the exact verified artifact once with
`npm publish --tag`. OIDC availability is checked before the write, no
`NPM_TOKEN` is stored, and provenance is generated by npm. If registry verification
or GitHub publication fails after the npm write, inspect the existing version
and workflow evidence before recovery; an npm version cannot be overwritten.

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
