# Publishing the maintained fork

The package is `@hypn4/chappie`, maintained in `hypn4/chappie`. Retain the upstream
MIT attribution, `chappie/chatgpt` provider, and `chappie-omp` executable.
Release candidates use `X.Y.Z-rc.N` on `next`; stable releases use `X.Y.Z` on
`latest`. Published versions are immutable.

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

## First publication

After all source and consumer jobs pass for the release commit, authenticate with
the owning npm account and publish the tested candidate once. Complete any 2FA
prompt locally; never put credentials in an issue, source file, or command log.

```sh
npm whoami
npm publish ./package.tgz --ignore-scripts --access public --tag next
npm trust github @hypn4/chappie --repo hypn4/chappie --file publish.yml --env release --allow-publish
npm trust list @hypn4/chappie
```

The package must exist before configuring its trusted publisher. `npm trust` needs
npm 11.15 or newer and account-level 2FA. After verifying trust, set the repository
variable `NPM_TRUSTED_PUBLISHING=true`. Until then only manual publish dry runs
are enabled. Keep the GitHub environment named `release`.

## Subsequent releases

Commit the version update to `main`, then push its exact `v<version>` tag.
`release.yml` runs the complete verification pipeline and creates a draft GitHub
Release from the checked artifact. Publish the draft to trigger `publish.yml`, or
run that workflow manually with an existing tag and `dry_run=false`.

The publish workflow requires the tagged commit to belong to `main`. It invokes
the same checks, then a separate `release` environment job downloads the verified
artifact and publishes it without rebuilding or installing source dependencies.
Only that job has `id-token: write`; it has no `NPM_TOKEN`, no package-manager cache,
and no dependency lifecycle scripts. OIDC generates provenance for the public
package and repository. `next` and `latest` are selected explicitly from the version.

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
