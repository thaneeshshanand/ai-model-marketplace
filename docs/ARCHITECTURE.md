# AIMM Technical Architecture

**AI Model Marketplace (AIMM)**
Thaneesh Shanand Lingan Anandakumar
AAI 6850 Applied Blockchain AI, Northeastern University College of Professional Studies

---

## 1. What the system does

AIMM is an enterprise marketplace for licensing AI models where quality claims are backed by
capital rather than by assertion.

A model provider bonds AIM tokens to list a model. Independent reporters submit benchmark
scores. If aggregated performance falls below a governed threshold, the provider's bond is
slashed and the model loses sellability automatically. Enterprises license models at a fixed
price through a commit-reveal flow that keeps procurement decisions private. Protocol
parameters are controlled by stake-weighted governance. Model provenance replicates from
Ethereum Sepolia to Base Sepolia.

The central design claim is that **a provider's economic exposure and their commercial
standing are the same variable**. `ModelRegistry.isListable` consults
`StakingVault.isBondedProvider` on every read, so a slashed provider stops being able to sell
without any administrative action, listing change, or manual intervention.

---

## 2. Contract topology

```
                         ETHEREUM SEPOLIA
   ┌──────────────────────────────────────────────────────────────┐
   │                                                              │
   │   AIMToken ──────────────┐                                   │
   │   fixed 1B supply        │ payment                           │
   │   no mint function       │ and stake                         │
   │                          ▼                                   │
   │                    StakingVault ◄──── slash ──── Performance  │
   │                    bonds, rewards                   Oracle    │
   │                    voting weight                      ▲       │
   │                          │                            │       │
   │              isBonded    │            provider lookup │       │
   │              Provider    ▼                            │       │
   │                    ModelRegistry ─────────────────────┘       │
   │                    canonical listings                         │
   │                          │        ▲                           │
   │             isListable   │        │ attest                    │
   │             getProvider  │        │                           │
   │             isHighRisk   ▼        │                           │
   │                     Marketplace   RegistryGateway             │
   │                     commit-reveal        │                    │
   │                          ▲               │                    │
   │            isCompliant   │               │ emits              │
   │                          │               │ ModelAttested      │
   │                 ComplianceRegistry       │                    │
   │                 attestations             │                    │
   │                 disclosure hashes        │                    │
   │                                          │                    │
   │   ParameterGovernor ── GOVERNOR_ROLE ────┼─► 4 contracts      │
   │   stake-weighted voting                  │                    │
   └──────────────────────────────────────────┼────────────────────┘
                                              │
                                    off-chain relayer
                                    (RELAYER_ROLE)
                                              │
   ┌──────────────────────────────────────────┼────────────────────┐
   │                         BASE SEPOLIA     ▼                    │
   │                                   RegistryReceiver            │
   │                                   mirror, advisory            │
   │                                                               │
   │   Independent instance of all seven core contracts            │
   │   (AIMToken, StakingVault, ModelRegistry, ComplianceRegistry, │
   │    Marketplace, PerformanceOracle, ParameterGovernor)         │
   └───────────────────────────────────────────────────────────────┘
```

Both chains run a complete, independently operable marketplace. The gateway and receiver pair
adds one-directional provenance replication on top.

---

## 3. Contract specifications

### 3.1 AIMToken

Fixed-supply ERC20. The entire supply is minted in the constructor and `_mint` is never
reachable again. There is no owner, no minter role, no pause, no transfer hook, and no
upgrade path.

| Property | Value |
|---|---|
| Name, symbol | AI Marketplace Token, AIM |
| Total supply | 1,000,000,000, immutable |
| Decimals | 18 |

| Allocation | Share | Amount |
|---|---|---|
| Staking rewards | 35% | 350,000,000 |
| Treasury | 25% | 250,000,000 |
| Team | 15% | 150,000,000 |
| Investors | 15% | 150,000,000 |
| Liquidity | 10% | 100,000,000 |

A constructor assertion enforces that the allocations sum to `MAX_SUPPLY`, so a future edit to
any constant fails at deployment rather than silently changing supply.

**Why no `ERC20Votes`.** Voting weight comes from staked balance, not token balance, so
checkpointing is unnecessary. See section 3.7.

**Why rewards are pre-funded rather than emitted.** A fixed supply still needs a reward
source. `StakingVault.fundRewards` pulls tokens from a funder, so the reward reserve is always
demonstrably backed. An emission schedule would require a mint function, which is the single
largest attack surface in token contracts.

### 3.2 StakingVault

Staking, reward distribution, provider bonding, slashing, and voting weight.

| Function | Access | Purpose |
|---|---|---|
| `stake` | open | Deposit AIM, reset lock and voting eligibility |
| `withdraw` | open | Retrieve unlocked stake, available while paused |
| `getReward` | open | Claim accrued rewards, available while paused |
| `fundRewards` | `REWARD_FUNDER_ROLE` | Deposit rewards, start or extend a period |
| `slash` | `SLASHER_ROLE` | Burn a provider bond to the treasury |
| `votingPowerAt` | view | Governance weight at a snapshot |
| `isBondedProvider` | view | Listing eligibility |
| `solvency` | view | Holdings against obligations |

**Reward accounting** uses the Synthetix accumulator pattern. `rewardPerTokenStored` advances
on every balance-changing call, so no function iterates over stakers. Distribution is O(1) and
cannot be griefed by a large staker set.

**Stake and reward funds are accounted separately.** The stake asset and reward asset are the
same token, which in a naive implementation lets reward payouts silently drain principal.
`totalStaked` and `rewardReserve` are tracked independently, and `solvency()` exposes the
invariant that holdings must always cover their sum.

**Slashing is capped at 50% of the target's stake per call** via `MAX_SLASH_BPS`. This bounds
the blast radius if the oracle holding `SLASHER_ROLE` is compromised, which is the largest
trust assumption in the system.

**Pause blocks new stakes but never withdrawals or claims.** A pause that traps user funds is
a liability, not a safety feature.

### 3.3 ModelRegistry

Canonical model listings and lifecycle.

**Listing requires a bond.** `registerModel` calls `isBondedProvider`. Capital at risk,
slashable by the oracle, is what makes a quality claim credible.

**Risk tier is self-declared by the provider**, not assigned centrally. This mirrors the EU AI
Act, under which providers self-assess and declare conformity. `RiskTier.Unacceptable` is
rejected outright at registration; `HighRisk` is permitted but triggers additional marketplace
obligations.

**Lifecycle is three states.**

| State | Set by | Reversible |
|---|---|---|
| Active | default at registration | n/a |
| Suspended | `CURATOR_ROLE` | Yes, by curator or governor |
| Retired | provider only | No |

No role can permanently destroy a provider's listing. A curator can suspend, governance can
override that suspension, and only the provider can retire. This bounds the centralisation the
curator role represents.

**No on-chain version history.** `metadataCID` is mutable and every change emits
`ModelUpdated` with both old and new values. Full history is reconstructable from events. An
append-only on-chain array would grow unboundedly and make any read touching it a gas
liability.

**No pause.** The registry custodies no funds; pausing it would strand providers without
protecting anything.

### 3.4 ComplianceRegistry

Entity attestations and privacy-preserving disclosure records.

**No personal data on-chain, ever.** Attestations record that an off-chain verification
occurred, identified only by a document hash. Names, documents, jurisdictions and identifiers
stay with the attestor. A public immutable ledger and the GDPR right to erasure are
fundamentally incompatible, so the design avoids the conflict rather than attempting to manage
it.

**Attestations expire.** Compliance is a continuing obligation, not a one-time gate, so every
attestation carries an expiry bounded by `MAX_VALIDITY_PERIOD` and periodic reverification is
structurally required.

**Revocation marks rather than deletes.** The historical record survives, which auditors
require.

**Disclosure grants are stored as hashes.** A public record reading "Provider A granted
Enterprise B access to Model C" leaks the commercial relationship, which is frequently the
sensitive part. Grants are stored as `keccak256(modelId, grantee, salt)`. A party holding the
tuple can prove the grant exists via `verifyDisclosure`; an observer cannot enumerate who has
access to what.

**Deliberate independence.** This contract knows nothing about models or `ModelRegistry`. It
attests to entities only. Keeping the dependency one-directional means it deploys first and
needs no post-deployment wiring, avoiding both a partially initialised contract and a
repointable admin setter.

### 3.5 Marketplace

Fixed-price licensing with commit-reveal purchase privacy.

**Fixed price, not an auction.** An AI model licence is a non-rival good: infinitely copyable
and sellable to any number of enterprises simultaneously. There is nothing to bid against, so
a sealed-bid auction would be mechanism theatre.

**Commit-reveal protects the buyer, not the price.** The privacy problem is not price
discovery, it is that a public `LicensePurchased(modelId, buyer)` event leaks which enterprise
is procuring which capability. That is a genuine enterprise objection to public ledgers.

The flow:

1. `commitPurchase(digest, escrowAmount)` where the digest is
   `keccak256(modelId, buyer, salt)` computed off-chain. Tokens are escrowed.
2. `revealPurchase(modelId, salt)` recomputes the digest, validates, and settles atomically.
3. `cancelCommitment(digest)` reclaims escrow if the window lapses unrevealed.

**The precise privacy claim.** An observer of a commit sees a buyer address and an escrow
amount, never the model. A buyer may deliberately over-escrow to obscure the price bracket as
well; the surplus refunds on reveal. What is not hidden is that a given address is purchasing
something, at reveal time.

**Compliance is evaluated at commit and recorded on the order.** Because the model is hidden
at commit time, the buyer's attestation status is checked unconditionally then and stored as
`compliantAtCommit`. At reveal, a high-risk model requires that recorded flag. This means an
attestation expiring mid-flight cannot strand a settlement that was compliant when initiated.

**Escrow is accounted separately** as `totalEscrowed`, mirroring the vault's separation, with
`solvency()` exposing the invariant.

**Pause blocks new commits only.** Reveal and cancel remain open, so a pause can never trap
escrowed funds.

### 3.6 PerformanceOracle

Benchmark aggregation and bond enforcement. This is where oracle data changes on-chain
behaviour.

**Permissioned reporter set, mean with a deviation guard.** Not a median. Median aggregation
defends against outliers in an open reporter network; this set is fixed, capped at
`MAX_REPORTERS` (7), and admitted by governance, so outlier resistance already comes from
permissioning. Sorting on-chain to compute a median would add gas cost and branch surface
against a threat the access model already handles.

Each submission after the first must fall within `maxDeviationBps` of the round's running
mean, which catches the failures that actually occur with a permissioned set: fat-finger
entries and single-reporter drift.

**Enforcement pipeline.**

```
submitScore ×N  →  finalizeRound  →  [flagged?]  →  challenge window
                                          │              │
                                          │              ├─ challenge() → round voided
                                          │              │
                                          └──────────────┴─ window lapses → enforceSlash()
                                                                                  │
                                                              StakingVault.slash(provider)
                                                                                  │
                                                              isBondedProvider → false
                                                                                  │
                                                              isListable → false
```

**Slashing is gated by a challenge window.** Benchmarks are noisy and reporters can be wrong,
so instant irreversible punishment on a single round is not defensible. A flagged model's
provider may call `challenge` to void the round, forcing a fresh one. There is deliberately no
on-chain arbitration: evidence handling belongs off-chain, and a contract adjudicating
benchmark disputes is outside this system's remit.

**Stale rounds cannot enforce.** A round older than `stalenessPeriod` is refused. Stale data
driving an irreversible economic consequence is the classic oracle failure.

**Finalization and enforcement are both permissionless.** Withholding either must not be a way
to shield a failing model.

### 3.7 ParameterGovernor

Stake-weighted governance over protocol parameters.

**Voting weight requires a pre-existing stake.** `votingPowerAt(account, snapshotTime)`
returns zero if the account increased its stake at or after the snapshot. A flash loan cannot
retroactively have existed, so vote buying within a transaction is structurally impossible.
Beanstalk lost roughly $182M in April 2022 to exactly the attack this prevents. This is also
why no `ERC20Votes` checkpointing is required.

**Quorum scales with participation.** It is fixed at proposal creation as basis points of
`totalStaked` at that moment, rather than being a stale absolute number.

**No separate timelock.** The execution delay is derived from the proposal, giving the same
guarantee as a `TimelockController` with half the deployment wiring.

**Proposal state is derived, never stored.** `state()` computes from timestamps and tallies, so
no transition write exists and no transition can be missed.

**Abstain counts toward quorum without endorsing**, so a holder can register participation
without distorting the tally.

**Targets are fixed at construction** with no setter, and the governor registers itself so its
own setters are reachable only through a passed proposal. Execution uses a low-level `call`,
bounded to exactly the privileges of `GOVERNOR_ROLE` on four contracts. It cannot mint, slash,
move escrow, grant roles, or pause.

**Self-governance is floor-bounded, not ceiling-bounded.** Quorum cannot fall below 4%, the
voting period below 5 minutes, or the execution delay below 5 minutes. Ceilings are
deliberately absent: governance making itself more conservative is not the attack.

The floors are set at demonstration values so a complete governance cycle is observable on a
testnet in one sitting. Production deployments should pass a voting period of 3 to 7 days and
an execution delay of 2 days. What the floor guarantees is structural rather than a policy
setting: no proposal, and no captured governance, can reduce either delay to zero.

### 3.8 RegistryGateway and RegistryReceiver

One-directional provenance replication, Sepolia to the destination chain.

`attestModel(modelId)` reads live registry state and emits `ModelAttested` carrying nonce,
model id, provider, listability, risk tier, and source timestamp. An off-chain relayer forwards
those six values unchanged to `receiveAttestation` on the destination chain.

**This is a permissioned relay, not a trustless bridge.** No light client, no proof
verification, no signature threshold. The security argument bounds the consequence rather than
eliminating the trust:

- `RegistryReceiver` writes only its own mirror mapping, holds no role on any other contract on
  either chain, custodies no funds, and makes no external calls.
- A compromised relayer can corrupt destination-chain mirror state and nothing else. It cannot mint, slash,
  vote, move escrow, or alter any Sepolia state.
- Mirrored data is advisory. No authoritative decision depends on it in this release.

This applies the Poly Network lesson as a design constraint. That bridge failed in August 2021
because the relay path could reach privileged functions on the destination contract. Here it
cannot reach any.

**Replay protection is a consumed-nonce mapping, not a sequence counter.** Requiring strictly
increasing nonces would let one failed message block every later one permanently, a liveness
failure with no upside since a registry mirror has no ordering requirement. Messages may arrive
out of order and each nonce is consumable exactly once.

**Stale-write guard.** Because delivery is unordered, an older attestation could arrive after a
newer one. `sourceTimestamp` is compared and older payloads are rejected, so the mirror only
moves forward per model.

---

## 4. User flows

### 4.1 Provider onboarding and listing

```
provider ─► AIMToken.approve(vault, amount)
         ─► StakingVault.stake(bond)                    [locks for lockPeriod]
         ─► ModelRegistry.registerModel(cid, riskTier)  [requires isBondedProvider]
         ─► Marketplace.createListing(modelId, price)   [requires isListable]
```

Failure modes: an unbonded provider is rejected at registration; an `Unacceptable` risk tier is
rejected outright; a provider slashed below the bond threshold loses `isListable` with no state
change to the listing itself.

### 4.2 Enterprise licence purchase

```
attestor    ─► ComplianceRegistry.grantAttestation(buyer, docHash, validity)

buyer       ─► compute keccak256(modelId, buyer, salt) off-chain
            ─► AIMToken.approve(marketplace, escrow)
            ─► Marketplace.commitPurchase(digest, escrow)
                                    │
                        [records compliantAtCommit; model stays hidden]
                                    │
            ─► Marketplace.revealPurchase(modelId, salt)
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
              fee → treasury  remainder →      surplus →
                              provider         buyer
                                    │
                        hasLicense[modelId][buyer] = true
```

If the buyer never reveals, `cancelCommitment` returns the escrow after `revealWindow`. High-risk
models require `compliantAtCommit`; minimal-risk models do not.

### 4.3 Performance enforcement

```
reporters ×3 ─► PerformanceOracle.submitScore(modelId, score)
                            │
                  [deviation guard rejects outliers]
                            │
anyone       ─► PerformanceOracle.finalizeRound(modelId)
                            │
                    mean ≤ failureThreshold ?
                            │
                ┌───────────┴───────────┐
               no                      yes
                │                       │
          round passes           flaggedAt set
                                        │
                            challenge window opens
                                        │
                        ┌───────────────┴───────────────┐
              provider challenges              window lapses
                        │                               │
              round voided, rescore          enforceSlash()
                                                        │
                                        slashBps of bond → treasury
                                                        │
                                        possible loss of sellability
```

### 4.4 Governance

```
staker ─► StakingVault.stake(...)                    [must predate the proposal]
       ─► ParameterGovernor.propose(target, calldata)
       ─► ParameterGovernor.castVote(id, For)
                     │
              votingPeriod elapses (≥ 5 min floor)
                     │
              state() → Succeeded
                     │
              executionDelay elapses (≥ 5 min floor)
                     │
       ─► ParameterGovernor.execute(id)  ─► target.call(calldata)
```

### 4.5 Cross-chain provenance

```
SEPOLIA                                          AMOY
provider registers model
        │
attestor ─► RegistryGateway.attestModel(id)
        │
   emits ModelAttested(nonce, id, provider,
              listable, highRisk, timestamp)
        │
        └────── relayer reads event ──────────►  RegistryReceiver
                                                 .receiveAttestation(same 6 values)
                                                         │
                                                 mirroredModels[id] written
                                                 isMirroredListable(id) → true

[later] curator suspends the model
        │
attestor ─► attestModel(id) again ─────────────►  receiveAttestation(...)
                                                         │
                                                 isMirroredListable(id) → false
```

---

## 5. Trust boundaries and privilege map

| Role | Holder | Can | Cannot |
|---|---|---|---|
| `DEFAULT_ADMIN_ROLE` | Deployer, multisig in production | Grant and revoke all roles | Move funds, change parameters directly |
| `GOVERNOR_ROLE` | `ParameterGovernor` | Change parameters on four contracts | Mint, slash, move escrow, grant roles |
| `SLASHER_ROLE` | `PerformanceOracle` | Burn bonds up to 50% per call | Anything else |
| `CURATOR_ROLE` | Operations | Suspend and reinstate listings | Retire a listing, touch funds |
| `ATTESTOR_ROLE` | Compliance operations | Grant and revoke attestations | Anything else |
| `REPORTER_ROLE` | Benchmark providers | Submit scores | Finalize alone, slash directly |
| `REWARD_FUNDER_ROLE` | Treasury operations | Deposit rewards | Withdraw them |
| `PAUSER_ROLE` | Operations | Block new stakes and commits | Block withdrawals, reveals, or claims |
| `RELAYER_ROLE` | Relayer account | Write destination-chain mirror entries | Reach any other contract |

**No role can mint AIM.** No mint function exists. **No role can withdraw another account's
stake or escrow.** **No role can prevent a user retrieving unlocked funds.**

---

## 6. Monitoring signals

Every state change emits a typed event. These are the signals an operations team would alert
on.

### Solvency invariants, alert on breach

| Signal | Source | Condition |
|---|---|---|
| Vault solvency | `StakingVault.solvency()` | `held >= owed` must always hold |
| Marketplace solvency | `Marketplace.solvency()` | `held >= owed` must always hold |

A breach in either indicates an accounting bug and warrants an immediate pause.

### Cross-chain sync health

| Signal | Source | Interpretation |
|---|---|---|
| Sync lag | `RegistryGateway.nonce()` minus `RegistryReceiver.highestNonce()` | Undelivered messages |
| Per-model latency | `RegistryReceiver.syncLatency(modelId)` | Seconds from attestation to delivery |
| Mirror completeness | `mirroredCount` against registry `modelCount` | Coverage gap |

### Economic and governance activity

| Event | Contract | Why it matters |
|---|---|---|
| `Slashed` | StakingVault | Provider bond burned |
| `SlashEnforced` | PerformanceOracle | Enforcement completed |
| `RoundChallenged` | PerformanceOracle | Repeated challenges indicate R-02 abuse |
| `RoundFinalized` with `flagged=true` | PerformanceOracle | Quality failure detected |
| `ProposalCreated` | ParameterGovernor | Governance activity begins |
| `ProposalExecuted` | ParameterGovernor | Parameter changed |
| `AttestationRevoked` | ComplianceRegistry | Compliance status withdrawn |
| `PurchaseCommitted` without a matching reveal | Marketplace | Escrow approaching expiry |

### Compliance operations

`ComplianceRegistry.timeUntilExpiry(entity)` supports proactive reverification before an
attestation lapses and blocks a high-risk purchase.

---

## 7. Deliberate omissions

Stating what was not built, and why, matters as much as describing what was.

| Omitted | Reason |
|---|---|
| Upgradeable proxies | Immutable core with governed parameters is a stronger guarantee to enterprise counterparties than a repointable implementation. Governance changes parameters, never logic. |
| `ERC20Votes` checkpointing | Stake-based voting makes it unnecessary and closes flash-loan governance attacks structurally. |
| On-chain vesting | Allocations go to distinct addresses so accounting is transparent from block zero. Vesting is documented as roadmap. |
| Token bridging | Not required by the brief. Would double the relayer surface. |
| Bidirectional messaging | One-directional sync satisfies the requirement and halves the trust surface. |
| Reporter bonding | Correct, but adds economic machinery beyond this release. Recorded as R-04. |
| On-chain dispute arbitration | A contract adjudicating benchmark disputes is beyond what this system should attempt. |
| Median aggregation | Permissioning already provides outlier resistance for a capped, governed reporter set. |
| destination-chain marketplace consuming the mirror | Would require duplicating the token, compliance registry, and listing set on a second chain for no additional demonstrated capability. `isMirroredListable` exposes the hook. |

---

## 8. Verification summary

| Metric | Result |
|---|---|
| Contracts | 9 production, 3 test-only mocks |
| Tests | 372, all passing |
| Statement coverage | 100% |
| Branch coverage | 96.61% |
| Function coverage | 100% |
| Line coverage | 100% |
| Slither findings | 37, none High or Critical, all triaged |
| solhint | Clean |
| Compiler warnings | None |
| CI | Green on every push, coverage and Slither artifacts published |

Every custom error in every contract has at least one test asserting it, verified mechanically
before each build stage was accepted. Branch coverage rather than statement coverage was treated
as the governing metric throughout, because statement coverage reached 100% while five decision
paths were still unexercised.

Full security analysis, including eight manual-review findings that static analysis cannot
surface, is in `SECURITY_AUDIT.md`.
