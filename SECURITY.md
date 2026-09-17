# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately through [GitHub's security advisory form](https://github.com/natevmp/vscode-smart-snippets/security/advisories/new). Do not include secrets or exploit details in a public issue.

## Dependency safety

The published extension bundles its runtime code and excludes `node_modules`. Development dependencies still execute on developer and CI machines during builds, tests, and packaging. Dependency lifecycle scripts are currently denied.

This repository therefore uses all of the following controls:

- `npm ci` installs the integrity-pinned dependency graph from `package-lock.json`.
- `.npmrc` enables npm's strict lifecycle-script policy.
- `package.json#allowScripts` records exact-version decisions for every current dependency installer. They are all denied because their required platform packages work without installer execution.
- `npm run security:audit` fails on any npm advisory; `npm run security:audit:runtime` separately checks the shipped dependency set.
- CI tests the oldest supported VS Code release as well as the current stable release.

An allowed lifecycle script runs with the current user's permissions. Treat an unexpected script-policy failure as a review request, not as a prompt to approve everything. To inspect a dependency update safely:

1. Use a disposable environment for untrusted branches or pull requests.
2. Run `npm ci --ignore-scripts`, followed by `npm install-scripts ls`.
3. Inspect the package source, ownership, lockfile change, and lifecycle command.
4. If the script is necessary and trustworthy, remove or revise any existing denial for it, then approve the exact installed version with `npm install-scripts approve --allow-scripts-pin <package>`. npm does not override an explicit denial automatically, so review the resulting `package.json` change.
5. Re-run a clean `npm ci` and the full verification suite.

Optional dependencies are explicitly included because, after a clean `npm ci` with an unmodified environment, esbuild loads its integrity-pinned platform package directly. Its installer is denied, so a missing platform package causes the build to fail instead of triggering the installer's nested-install or download fallback. The VS Code signing installer is also denied: ordinary VSIX packaging does not need it, while signature-specific commands will fail until the denial and the installer's nested-install/direct-download fallbacks are separately reviewed. Any package version change must be reviewed again.
