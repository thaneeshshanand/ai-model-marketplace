# AI Model Marketplace (AIMM)
## Phase 0: Toolchain Validation

Goal: prove the toolchain works before any capstone code is written. Roughly 45 minutes,
most of it waiting. Nothing here ships in the final submission.

---

## Step 1. Create the repository

On github.com, create a new repository:

- Name: `ai-model-marketplace`
- Visibility: **Private** for now, flip to Public before submission
- Do not add a README, .gitignore, or licence. The upload provides them.

## Step 2. Upload these files

On the empty repo page, choose **uploading an existing file**, then drag in the whole
extracted folder. Confirm all eleven files land, including the dot-folders
`.devcontainer` and `.github`.

If the browser drops the dot-folders, use `Add file > Create new file` and type the path
including slashes, for example `.devcontainer/devcontainer.json`. GitHub creates the
folder automatically.

Commit to `main`.

## Step 3. Launch the Codespace

Green **Code** button > **Codespaces** tab > **Create codespace on main**.

First build takes three to five minutes. Watch the terminal. When the bootstrap finishes
you should see a version block:

```
node    : v20.x.x
npm     : 10.x.x
python  : Python 3.11.x
slither : 0.10.x
solc    : Version: 0.8.24+...
```

Any line reading `MISSING` is a problem. Copy the log and send it to me.

## Step 4. Run the validation

In the Codespace terminal:

```bash
npm run verify
```

That chains lint, compile, test, and coverage.

### What success looks like

**Tests:** five passing.

```
  Ping (Phase 0 toolchain validation)
    ✔ deploys and records the deployer as owner
    ✔ increments the counter on the first ping
    ✔ emits Pinged with the caller and the new count
    ✔ rejects a second ping inside the cooldown window
    ✔ allows a second ping once the cooldown has elapsed

  5 passing
```

**Coverage:** a table, and critically **not 100 percent**.

```
------------|----------|----------|----------|----------|
File        |  % Stmts | % Branch |  % Funcs |  % Lines |
------------|----------|----------|----------|----------|
 Ping.sol   |    ~78   |    ~50   |    ~66   |    ~78   |
------------|----------|----------|----------|----------|
```

Sub-100 percent is the point. `reset()` and the `onlyOwner` revert path are deliberately
untested. If it reported 100 percent, the instrumentation would not be working.

**Lint:** warnings are fine. Errors are not.

## Step 5. Commit the lockfile

`npm install` generated `package-lock.json`. CI uses `npm ci`, which requires it.

```bash
git add package-lock.json
git commit -m "Add package lockfile for reproducible CI installs"
git push
```

The push triggers CI. Open the **Actions** tab and wait for both jobs.

## Step 6. Run Slither

```bash
npm run slither
```

Expect roughly three to six findings, including:

- `immutable-states` — `Ping.owner` should be immutable *(optimisation)*
- `timestamp` — `Ping.ping()` uses `block.timestamp` for comparisons *(low)*
- possibly `solc-version` depending on the detector set

Both of the first two are planted deliberately. Seeing them proves Slither is analysing
real control flow rather than exiting early.

---

## Send me back

1. Paste the version block from Step 3
2. Paste the coverage table
3. Paste the Slither findings summary
4. Screenshot of the Actions tab with both jobs green
5. Any error text, verbatim, if something failed

Once those land I delete `Ping.sol` and its test, then start Phase 1 with `AIMToken` and
`StakingVault`.

---

## Troubleshooting

**npm install fails on a peer dependency.** Send me the exact error. The stack is pinned
to a combination I believe is stable, but I could not test it offline, so a version bump
may be needed.

**`Cannot use import statement outside a module` in tests.** Almost certainly Chai 5,
which is ESM-only. `package.json` pins `chai: ^4.5.0` for this reason. Verify with
`npm ls chai`.

**Slither reports `Invalid compilation`.** It compiles through Hardhat, so fix compilation
first: `npx hardhat compile`.

**`crytic/slither-action@v0.4.0` not found.** The action version may have moved since my
information cutoff. Check the marketplace for the current tag and update `ci.yml`.

**Codespace will not start.** Confirm free-tier hours remain under Settings > Billing.
The container auto-stops when idle, so an open tab is not burning time.

---

## Design decisions already baked in

These carry through to the final report, so they are worth knowing now.

| Decision | Reason |
|---|---|
| JavaScript, not TypeScript | Removes typechain and tsconfig from the failure surface |
| `evmVersion: "paris"` | Avoids PUSH0 and MCOPY, so identical bytecode deploys on any testnet |
| No network config beyond `hardhat` | No private key ever enters the repo; deployment is from Remix via MetaMask |
| `fail-on: none` for Slither in CI | Keeps CI green during triage; tightens to `high` once the audit report exists |
| Explicit plugin list, no toolbox bundle | Each dependency is visible and individually pinnable |
