# AIMM Security Audit Report

**AI Model Marketplace (AIMM)**
Prepared by Thaneesh Shanand Lingan Anandakumar
AAI 6850 Applied Blockchain AI, Northeastern University College of Professional Studies

---

## 1. Scope and methodology

### Contracts in scope

Nine production contracts. Three test-only mocks are excluded from remediation
expectations but were analysed and are reported where flagged.

| Contract | Purpose |
|---|---|
| `AIMToken` | Fixed-supply ERC20 utility and governance token |
| `StakingVault` | Staking, rewards, provider bonds, slashing, voting weight |
| `ModelRegistry` | Canonical model listings and lifecycle |
| `ComplianceRegistry` | Entity attestations and selective disclosure |
| `Marketplace` | Fixed-price licensing with commit-reveal purchase privacy |
| `PerformanceOracle` | Benchmark aggregation and bond enforcement |
| `ParameterGovernor` | Stake-weighted parameter governance |
| `RegistryGateway` | Cross-chain attestation emitter (Sepolia) |
| `RegistryReceiver` | Cross-chain registry mirror (Amoy) |

### Toolchain

| Component | Version |
|---|---|
| Slither | 0.11.6, 102 detectors |
| solc | 0.8.24, EVM target `paris`, optimizer enabled at 200 runs |
| Hardhat | 2.29.0 |
| solidity-coverage | 0.8.17 |
| solhint | 5.x, `solhint:recommended` |
| Node | 22.16.0 |

### Methods applied

1. **Automated static analysis.** Slither across all 35 compiled units, 102 detectors,
   executed in CI on every push via `crytic/slither-action`.
2. **Linting.** solhint against `solhint:recommended`. Currently zero warnings and zero
   errors.
3. **Test-driven verification.** 372 tests. Every custom error in every contract has at
   least one test asserting it, verified mechanically before each phase was accepted.
4. **Coverage measurement.** solidity-coverage, with branch coverage treated as the
   governing metric rather than statement coverage.
5. **Manual review.** Adversarial reasoning about trust boundaries, role privilege,
   economic incentives and cross-contract interaction. Section 5 records what this
   surfaced, which is where the substantive risks live.

### Test evidence

| Metric | Result |
|---|---|
| Tests passing | 372 |
| Statement coverage | 100% |
| Branch coverage | **96.61%** |
| Function coverage | 100% |
| Line coverage | 100% |

Per-contract branch coverage: `AIMToken` 100%, `ComplianceRegistry` 100%,
`ModelRegistry` 100%, `ParameterGovernor` 100%, `RegistryGateway` 100%,
`RegistryReceiver` 100%, `PerformanceOracle` 95.08%, `StakingVault` 95.83%,
`Marketplace` 93.14%.

Statement coverage alone would have overstated test quality. Branch coverage began at
89.13% after Phase 1 with 100% statements, so five uncovered decision paths existed behind
a perfect statement figure. Section 4.3 records how that gap was closed.

---

## 2. Findings summary

The initial scan reported **38 results across 8 detectors**. After remediation the scan
reports **37 results across 7 detectors**, with `divide-before-multiply` eliminated. Both
figures are reproducible from the repository: the post-remediation run is the one attached
as a CI artifact on the current commit.

| Disposition | Count |
|---|---|
| Fixed and verified removed | 1 |
| Accepted with justification | 33 |
| False positive | 4 |
| **Total, initial scan** | **38** |
| **Remaining, post-remediation** | **37** |

By detector:

| Detector | Count | Slither severity | Disposition |
|---|---|---|---|
| `divide-before-multiply` | 1 | Medium | **Fixed** |
| `incorrect-equality` | 5 | Medium | False positive (4), Accepted (1) |
| `reentrancy-events` | 2 | Low | Accepted |
| `timestamp` | 17 | Low | Accepted by design |
| `cyclomatic-complexity` | 1 | Informational | Accepted |
| `low-level-calls` | 1 | Informational | Accepted by design |
| `missing-inheritance` | 4 | Informational | Accepted, roadmap |
| `naming-convention` | 8 | Informational | Accepted, deliberate deviation |

**No High or Critical findings were reported.**

---

## 3. Fixed findings

### F-01 divide-before-multiply, Medium, FIXED

**Location** `PerformanceOracle.submitScore`, deviation guard.

**Reported** A multiplication consumed the result of an integer division:

```
runningMean = r.sum / r.count
(delta * SCORE_SCALE) > (runningMean * maxDeviationBps)
```

**Analysis** Integer division truncates, so `runningMean` was at most one unit low, which
made the right side slightly smaller and the guard marginally stricter than intended. The
error direction was therefore conservative and the magnitude was bounded by
`maxDeviationBps`, so no exploit path existed. It remained a genuine precision defect and
was worth removing rather than justifying.

**Fix** Multiplying both sides of the comparison by `count` yields an algebraically
identical test containing no division:

```
scaledDelta = |score * count - sum|          // equals delta * count
reject if     scaledDelta * SCORE_SCALE > sum * maxDeviationBps
```

The mean is now computed only on the revert path, purely to populate the error message, so
no product ever consumes a truncated value.

**Verification** Behaviour was confirmed identical to the original across an exhaustive
sweep of reporter counts 1 to 7 against all exact-mean score combinations: zero
divergences. A follow-up Slither run confirms the detector no longer fires, taking the total
from 38 findings across 8 detectors to 37 across 7. Overflow is impossible, since `score` is bounded by `SCORE_SCALE` (10,000) and
`count` by `MAX_REPORTERS` (7), giving a largest intermediate of 7e8 against a uint256
ceiling. All existing tests, including the deviation-boundary case, pass unchanged.

---

## 4. Accepted findings

### 4.1 F-02 incorrect-equality, Medium, 5 instances

**Locations** `PerformanceOracle.enforceSlash` (`bond == 0`, `amount == 0`),
`StakingVault.fundRewards` (`rewardRate == 0`), `StakingVault.getReward` (`reward == 0`),
`StakingVault.votingPowerAt` (`lastIncreaseAt[account] == 0`).

**Disposition** Four false positives, one accepted.

This detector targets strict equality against values an attacker can manipulate, classically
`address(this).balance == x`, which forced transfers can defeat. None of these five compare
against an externally influenceable balance:

- `bond == 0` and `amount == 0` guard against slashing an unbonded provider or slashing
  zero. Both read internal vault accounting, not a token balance.
- `rewardRate == 0` detects integer division rounding a reward rate to zero. Comparing to
  zero is the entire point of the check.
- `reward == 0` is an early return when nothing is owed.
- `lastIncreaseAt[account] == 0` is an existence sentinel. Zero is unreachable for any
  account that has ever staked, since `block.timestamp` is never zero.

The fifth, `lastIncreaseAt[account] == 0`, is **accepted rather than dismissed** because it
relies on a sentinel convention rather than an explicit existence flag. The convention is
sound and documented in NatSpec, but a reader must know it. A future refactor adding an
explicit `bool exists` would be marginally clearer at the cost of a storage slot.

### 4.2 F-03 reentrancy-events, Low, 2 instances

**Locations** `PerformanceOracle.enforceSlash`, `ParameterGovernor.execute`.

**Disposition** Accepted.

Both functions emit an event after an external call. Critically, **both set their guard
state before the call**:

```solidity
// PerformanceOracle.enforceSlash
r.enforced = true;
STAKING_VAULT.slash(provider, amount);
emit SlashEnforced(...);

// ParameterGovernor.execute
p.executed = true;
(bool ok, ) = p.target.call(p.data);
if (!ok) revert ExecutionFailed(proposalId);
emit ProposalExecuted(...);
```

So the checks-effects-interactions ordering holds for all state. Re-entering
`enforceSlash` hits `AlreadyEnforced`; re-entering `execute` hits
`ProposalAlreadyExecuted`. The finding concerns only the ordering of log entries relative
to nested events, which affects off-chain indexer interpretation rather than contract
safety.

Moving each `emit` above its call would silence the detector, since a revert would unwind
the log regardless. That was declined because it would place the event before the outcome it
reports, making the log chronologically misleading in exchange for a cleaner tool report.

### 4.3 F-04 timestamp, Low, 17 instances

**Locations** Across `ComplianceRegistry`, `Marketplace`, `ParameterGovernor`,
`PerformanceOracle`, `StakingVault`.

**Disposition** Accepted by design.

Every time-dependent guarantee in the system rests on `block.timestamp`: attestation
expiry, licence reveal windows, commitment cancellation, voting periods, execution delays,
oracle challenge windows, score staleness, and stake lock periods. This is not incidental
use; it is the mechanism.

The threat is proposer timestamp manipulation. Under Ethereum proof of stake, block
timestamps are constrained to 12-second slot boundaries and a proposer's discretion is
bounded to a few seconds.

The shortest windows in the system are the deployed testnet demonstration values: a 60-second
oracle challenge period and 5-minute governance floors. Against a manipulation budget of a few
seconds these give margins of roughly 5x and 50x respectively.

**This margin is stated precisely rather than generously.** At 60 seconds the 5x margin on the
challenge window is the thinnest tolerance in the system, and a proposer with sustained control
of consecutive slots could compress it meaningfully. The mitigation is that these are
demonstration values: production settings recommended in the deployment runbook are 7 days for
the challenge window and days for the governance delays, restoring margins of four orders of
magnitude. The parameters are governance-adjustable precisely so this can be corrected without
redeployment, and the immutable floors guarantee they can never reach zero.

Note that Slither groups all comparisons within a timestamp-using function under this
detector, so several entries in the raw output are actually the `== 0` checks addressed in
F-02 rather than distinct timestamp issues.

**Residual risk** Low, and inherent to any on-chain time-gated mechanism. Block numbers
were considered as an alternative and rejected: they introduce chain-specific block-time
assumptions, which is worse in a system deployed to two chains with different block times.

### 4.4 F-05 cyclomatic-complexity, Informational, 1 instance

**Location** `Marketplace.revealPurchase`, complexity 12.

**Disposition** Accepted.

The function validates six independent preconditions before settling: commitment exists,
not already settled, caller is the committer, reveal window still open, listing active and
model still listable, buyer not already licensed, and compliance recorded at commit if the
model is high-risk. It then computes the fee split and performs three transfers.

Extracting validation into a helper would lower the metric without lowering the real
complexity, and would move the settlement preconditions out of the function that depends on
them. For a function that moves user funds, having every precondition visible in one place
is worth more than a metric.

Mitigating evidence: `revealPurchase` and its guards are covered by 17 dedicated tests
including all six revert paths and both sides of the high-risk compliance gate.

### 4.5 F-06 low-level-calls, Informational, 1 instance

**Location** `ParameterGovernor.execute`, `p.target.call(p.data)`.

**Disposition** Accepted by design. This is the most security-significant accepted finding
and warrants the fullest justification.

A parameter governor that can execute arbitrary encoded calls requires a low-level call.
The alternative, whitelisting individual function selectors, roughly doubles the
maintenance surface and still cannot express calls the designers did not anticipate.

Four controls bound the consequence:

1. **The target set is fixed at construction.** There is no setter. Governance cannot
   extend its own reach, because extending the allowlist would itself require a call to a
   function that does not exist.
2. **The governor holds only `GOVERNOR_ROLE`** on `StakingVault`, `ModelRegistry`,
   `Marketplace` and `PerformanceOracle`. The blast radius is exactly that role's
   privileges: parameter setters. It cannot mint (no mint function exists anywhere), cannot
   slash (`SLASHER_ROLE` belongs to the oracle), cannot move escrow, cannot grant roles,
   and cannot pause.
3. **The return value is checked** and a failed call reverts the whole execution with
   `ExecutionFailed`, so a proposal cannot be marked executed on a silent failure.
4. **Self-governance is floor-bounded.** Even a fully captured governance cannot reduce
   quorum below `MIN_QUORUM_BPS` (4%), the voting period below 5 minutes, or the execution
   delay below 5 minutes. Tests demonstrate this: a proposal setting quorum to 399 passes
   the vote, reaches execution, and reverts inside the setter with quorum unchanged.

**Residual risk** Documented in Section 5 as R-03.

### 4.6 F-07 missing-inheritance, Informational, 4 instances

**Reported** `ComplianceRegistry` should inherit `IComplianceView`, `ModelRegistry` should
inherit `IModelRegistryView`, and the two mocks should inherit their corresponding
interfaces.

**Disposition** Accepted, with remediation on the roadmap.

This is a legitimate observation. Consumer contracts declare minimal local interfaces
(`IModelRegistryView`, `IComplianceView`, `IStakingBond`, `IStakingVotes`,
`IStakingSlasher`, `IRegistrySource`) describing only the functions they call. The
implementations do not inherit those interfaces, so a signature change in an implementation
would not be caught at compile time.

Accepted for this release on the following reasoning: the drift risk the finding describes
is already caught by the test suite, which exercises every cross-contract call against real
implementations rather than mocks wherever the interaction is security-relevant. The oracle
tests drive a real `StakingVault`, the governor tests drive a real `Marketplace` and real
`StakingVault`, and the cross-chain tests drive a real `ModelRegistry`. Any signature
divergence would fail those 372 tests before reaching deployment.

The deliberate design benefit of minimal local interfaces is that each consumer's
dependency is visible and minimal: `Marketplace` depends on three registry functions, not
on the whole of `ModelRegistry`. This is what allows `Marketplace` to be pointed at a
mirrored registry on another chain without modification.

**Remediation plan** Extract shared interfaces to `contracts/interfaces/` and have both
implementations and consumers reference them, gaining compile-time enforcement while
retaining minimal surface. Deferred rather than dismissed, because performing a nine-contract
refactor against a green test suite immediately before submission carries more risk than the
finding it addresses.

### 4.7 F-08 naming-convention, Informational, 8 instances

**Reported** Eight immutable state variables use SCREAMING_SNAKE_CASE:
`Marketplace.PAYMENT_TOKEN`, `MODEL_REGISTRY`, `COMPLIANCE_REGISTRY`,
`ParameterGovernor.STAKING_VAULT`, `PerformanceOracle.STAKING_VAULT`, `MODEL_REGISTRY`,
`RegistryGateway.MODEL_REGISTRY`, `StakingVault.STAKING_TOKEN`.

**Disposition** Accepted as a deliberate deviation.

Slither's convention reserves SCREAMING_SNAKE_CASE for `constant` and expects `mixedCase`
for `immutable`. The codebase deliberately treats both as one category, because from a
caller's and auditor's perspective they share the property that matters: the value cannot
change after deployment. `STAKING_TOKEN` signals that immediately; `stakingToken` reads like
mutable storage and invites the question of whether a setter exists.

solhint, the project's configured linter, does not object. The deviation is uniform across
all nine contracts, so there is no internal inconsistency for a reader to trip over.

Renaming was declined because it would touch the contracts and every test asserting against
them, for a stylistic preference, at a point in the schedule where regression risk outweighs
the benefit.

---

## 5. Manual review findings

These are not Slither findings. Static analysis cannot reason about economic incentives,
trust boundaries or governance dynamics, and this section is where the substantive risk in
the system actually sits. Each was identified during design and is recorded here rather than
discovered by a reader.

### R-01 Trusted cross-chain relayer, HIGH inherent, bounded consequence

The cross-chain sync is a permissioned relay, not a trustless bridge. There is no light
client, no proof verification and no signature threshold. An account holding `RELAYER_ROLE`
on `RegistryReceiver` can publish arbitrary mirror entries on Polygon Amoy.

**Why this is acceptable rather than dismissed.** The consequence is bounded by design:

- `RegistryReceiver` writes only its own mirror mapping. It holds no role on any other
  contract on either chain, custodies no funds, and makes no external calls.
- A compromised relayer can therefore corrupt Amoy mirror state and nothing else. It cannot
  mint, slash, vote, move escrow, or alter any Sepolia state.
- Mirrored data is advisory on the destination chain. No authoritative decision depends on
  it in this release.

This is the Poly Network lesson applied as a design constraint. That bridge failed in August
2021 because the relay path could reach privileged functions on the destination contract.
Here it cannot reach any.

**Evidence** Two tests substantiate this rather than asserting it. One confirms the receiver
holds none of `CURATOR_ROLE`, `GOVERNOR_ROLE` or `DEFAULT_ADMIN_ROLE` on the registry. The
other has the relayer publish a fabricated model 42 and then confirms the source chain has
never heard of it.

**Roadmap** Chainlink CCIP or a multi-signature attestation threshold. Rejected for this
release because both pin the system to third-party router addresses and lane availability
that could not be verified offline, introducing a delivery risk that outweighs the trust
reduction for a testnet demonstration.

### R-02 Repeated challenge can delay enforcement indefinitely

`PerformanceOracle.challenge` lets a model's provider void a flagged round during the
challenge window, forcing reporters to run a fresh round. Nothing caps how many times this
can happen, so a determined provider can postpone slashing indefinitely at the cost of one
transaction per round.

**Accepted.** A proper fix requires a challenge bond forfeited on an unsuccessful challenge,
or a strike counter escalating to automatic enforcement. Both add economic machinery beyond
what this release warrants. The mitigation in place is that a challenged model remains
subject to re-scoring and its poor scores remain publicly visible on-chain, so the
reputational consequence is not avoidable even when the economic one is delayed.

### R-03 Governance deadlock freezes four contracts

`ParameterGovernor` holds `GOVERNOR_ROLE` on `StakingVault`, `ModelRegistry`, `Marketplace`
and `PerformanceOracle`. If governance deadlocks, for example because staked supply falls
so far that quorum becomes unreachable, every governed parameter across those four contracts
is frozen permanently.

**Accepted, with a stated centralisation trade-off.** The floors described in F-06 reduce
the likelihood of a captured governance disabling itself, but they cannot prevent
insufficient participation. The actual mitigation is that `DEFAULT_ADMIN_ROLE` on each
target contract remains with the deploying account, which can grant `GOVERNOR_ROLE` to a
replacement governor as a break-glass measure.

**This is genuine centralisation and is stated plainly rather than buried.** In production
that role should sit with a multi-signature wallet under a published operating policy. The
system is not trustless with respect to protocol parameters, and the honest description is
that it is governance-managed with an administrative backstop.

### R-04 Oracle reporters have nothing at stake

Reporters submit benchmark scores that destroy other parties' capital while bearing no
economic risk themselves. The only control is governance-managed admission, capped at
`MAX_REPORTERS` (7).

**Accepted.** Reporter bonding is the correct fix and is a roadmap item. Partial mitigations
in place: the deviation guard rejects submissions far from a round's running mean, limiting a
single rogue reporter's influence; the quorum requirement means one reporter cannot finalize
a round alone; and the challenge window gives providers recourse before any bond is burned.

**Honest limitation.** If a majority of the reporter set colludes, neither the deviation
guard nor a median would help. Permissioned admission is the entire defence against that
case.

### R-05 Curator suspension is unilateral

`CURATOR_ROLE` on `ModelRegistry` can suspend any listing, immediately ending its
sellability through `isListable`. There is no appeal process on-chain.

**Accepted, with the power deliberately split.** Suspension is reversible and can be
overridden by `GOVERNOR_ROLE`, so a curator cannot permanently destroy a listing. Only the
provider can retire a model, and only the provider's own retirement is irreversible. No role
in the system can permanently terminate a provider's listing against their will.

### R-06 `setStakingVault` can be repointed

`ModelRegistry.setStakingVault` allows `GOVERNOR_ROLE` to change the bond source. A
malicious vault could report every provider as adequately bonded, defeating the bonding
requirement entirely.

**Accepted as necessary.** `StakingVault` could legitimately need redeployment, and a
registry permanently bound to a broken vault would be worse. The mitigation is that the
function is governance-gated and therefore subject to the voting period and execution delay,
giving the community the full voting period plus execution delay of visibility before such a
change takes effect. At deployed testnet values that is 10 minutes; at recommended production
values it is 5 to 9 days.

### R-07 Unreachable defensive branch retained

`StakingVault.getReward` contains a cap for the case where accrued reward exceeds
`rewardReserve`. Analysis shows this branch is unreachable in production: `rewardRate =
amount / duration` uses integer division, so total distributable never exceeds the amount
funded, and the leftover rollover in `fundRewards` preserves that property. Rounding always
favours the reserve.

**Retained deliberately** as defence in depth against a future change to the reward
mathematics, and covered by `StakingVaultHarness`, a test-only contract that forces the
condition to prove the guard behaves correctly. The harness is excluded from the coverage
denominator via `.solcover.js` so that test scaffolding does not inflate the reported figure.

### R-08 Vote tallies can outlive the stake backing them

A voter may unstake after casting, so a proposal's tally can include weight no longer at
risk by the time execution occurs.

**Accepted and documented as a property rather than a defect.** Verified that this does not
enable double voting: a recipient of transferred tokens has a `lastIncreaseAt` postdating the
proposal snapshot, so `votingPowerAt` returns zero for them. Both facts are covered by
dedicated tests.

---

## 6. Residual risk register

| ID | Risk | Inherent severity | Post-mitigation | Owner |
|---|---|---|---|---|
| R-01 | Trusted relayer can corrupt Amoy mirror | High | Low, consequence bounded to advisory state | Protocol ops |
| R-02 | Repeated challenge delays slashing | Medium | Medium, reputational exposure remains | Governance |
| R-03 | Governance deadlock freezes parameters | Medium | Low, admin break-glass exists | Multisig holder |
| R-04 | Reporters unbonded | Medium | Medium, admission-controlled only | Governance |
| R-05 | Curator suspends unilaterally | Medium | Low, reversible and override-able | Governance |
| R-06 | Bond source repointable | Medium | Low, governance-delayed | Governance |
| R-07 | Unreachable defensive branch | Informational | Informational, harness-tested | Engineering |
| R-08 | Tallies outlive stake | Low | Low, no double-voting path | Documented |

---

## 7. Remediation log

| Finding | Action | Verification |
|---|---|---|
| F-01 `divide-before-multiply` | Restructured the deviation guard to eliminate division | Exhaustive equivalence sweep, all tests pass |
| Phase 1 branch coverage gap | Converted the `updateReward` modifier to an explicit internal call, removing five unreachable post-placeholder branches | Branch coverage 89.13% to 96.34% |
| Phase 1 untested guard | Added `StakingVaultHarness` to reach the reward reserve cap | Guard now covered by test |
| Phase 1 missing access check | Added an `unpause` access-control test | Branch closed |
| Phase 3 lint warnings | Renamed the identifier `l`, which solhint flags as confusable with `1` and `I` | solhint clean |
| Phase 4 compiler warning | Renamed a local shadowing the `executableAt` function | Compiler clean |
| Phase 5 arithmetic bug | Guarded `syncLatency` against underflow from cross-chain clock skew | Test with future source timestamp |

The `syncLatency` fix is worth highlighting as a manual-review catch that no tool reported.
Subtracting a source-chain timestamp from a destination-chain timestamp underflows whenever
the destination clock runs behind, which is entirely possible between independent chains, and
would have reverted a view function that monitoring depends on.

---

## 8. Continuous verification

Security checks run automatically on every push to `main` via GitHub Actions:

| Job | Steps |
|---|---|
| `build-test-coverage` | solhint, compile, 372 tests, coverage, artifact upload |
| `static-analysis` | Slither via `crytic/slither-action`, JSON report artifact upload |

Both jobs publish downloadable artifacts, so the coverage report and Slither output attached
to any commit can be independently retrieved and verified rather than taken on trust.

Slither currently runs with `fail-on: none` so that findings remain visible during
development without blocking the pipeline. Now that every finding is triaged, the correct
production posture is `fail-on: high`, which fails the build on any new High or Critical
finding while permitting the Low and Informational items accepted above.

---

## 9. Conclusion

Automated analysis reported no High or Critical findings. The single Medium-severity defect
with a real, if bounded, impact was fixed by removing the division rather than justifying
it. The remaining 37 findings are Low or Informational and are dispositioned individually
above, with four identified as false positives on reasoning specific to each site.

The material risks in this system are not the ones a static analyser can see. They are the
trusted cross-chain relayer, the absence of reporter bonding, and the administrative
backstop on governance. Each is documented with its inherent severity, the controls that
bound it, and the roadmap item that would remove it. None is concealed, and two of the three
are substantiated by tests that demonstrate the bound rather than assert it.
