# AIMM Deployment Runbook

Deploy from Remix IDE via MetaMask. No private key ever enters the repository or the
Codespace.

**Fourteen deployments total.** Eight on Ethereum Sepolia, six on Polygon Amoy. See the Amoy
scope section below for what is deployed where and why.

---

## Schedule, 10-hour window

Governance latency is now 10 minutes, not 25 hours, so nothing needs a long wait. The risk in a
10-hour window is not any single step, it is spending so long on deployment that packaging and
submission get squeezed. Work to this order and protect the last two hours.

| Elapsed | Task | Cut if behind |
|---|---|---|
| 0:00 to 0:30 | Pull the floor change, run `npm run verify`, commit, push | no |
| 0:30 to 2:15 | Sepolia: 8 deployments, 9 role-wiring transactions | no |
| 2:15 to 2:45 | Stake, register, list, purchase. Record as you go | no |
| 2:45 to 3:15 | Oracle: score, finalize, wait 60s, enforce slash. Record | no |
| 3:15 to 3:30 | Governance: propose, vote, wait 10 min, execute. Record | can cite tests instead |
| 3:30 to 4:15 | Amoy: 6 deployments, no wiring | no, needed for requirement 1 |
| 4:15 to 4:45 | Cross-chain relay both directions of state. Record | no, highest rubric weight |
| 4:45 to 5:45 | Verify contracts on both explorers | Amoy verification first to go |
| 5:45 to 6:15 | Send addresses; README and ZIP get built | no |
| 6:15 to 8:00 | Review, corrections | no |
| 8:00 to 10:00 | **Buffer. Do not plan work here** | n/a |

If you reach 5:45 without finishing deployment, stop deploying and send what you have. A
submission with Sepolia deployed and Amoy documented as untested beats a complete deployment
that misses the deadline.

## Amoy scope, reduced

**Sepolia carries all eight contracts and every demonstrated flow.** Amoy carries six contracts
and serves two purposes: satisfying the multi-testnet deployment requirement, and receiving the
cross-chain relay.

Deploy on Amoy: `AIMToken`, `ComplianceRegistry`, `StakingVault`, `ModelRegistry`,
`Marketplace`, `RegistryReceiver`.

Skip on Amoy: `PerformanceOracle` and `ParameterGovernor`, both fully demonstrated on Sepolia.

Skip Amoy role wiring entirely. The nine wiring transactions exist to enable oracle slashing and
governance, neither of which is demonstrated on Amoy. `RegistryReceiver` grants `RELAYER_ROLE`
in its constructor, so the relay works without any further transaction.

State this scoping in the README rather than leaving it to be noticed: Amoy is an independent
marketplace deployment and relay endpoint, with flow demonstration concentrated on Sepolia to
fit the submission window.

## Prerequisites

| Item | Detail |
|---|---|
| Sepolia ETH | Roughly 0.15 ETH covers eight deployments plus wiring |
| Amoy POL | Faucet amounts are ample; gas is negligible |
| MetaMask | Both networks added, same account |
| Remix | Solidity compiler 0.8.24, optimizer enabled, 200 runs, EVM version `paris` |

Compiler settings must match `hardhat.config.js` or verified source will not match bytecode.

### Accounts

One MetaMask account is sufficient for a testnet demo. If you have several, this mapping is
more realistic and costs nothing extra:

| Label | Purpose |
|---|---|
| `admin` | Deployer, holds DEFAULT_ADMIN_ROLE everywhere |
| `treasury` | Receives fees and slashed bonds |
| `provider` | Registers and lists a model |
| `buyer` | Licenses a model |
| `reporter1..3` | Submit oracle scores |

Reusing `admin` for all of these works. The oracle needs three distinct reporter addresses
to reach quorum, so if you have only one account, lower quorum to 1 after deployment with
`setQuorum(1)`.

---

## Testnet parameter values

Deliberately short so every flow is demonstrable in one sitting. Production
recommendations are in the right column and belong in the documentation.

| Parameter | Testnet | Production | Why |
|---|---|---|---|
| `lockPeriod` | `300` (5 min) | 7 to 30 days | Full stake and withdraw cycle in one sitting |
| `minProviderBond` | `1000000000000000000000` (1000 AIM) | Market-dependent | Round number, easy to reason about |
| `protocolFeeBps` | `500` (5%) | 250 to 500 | Governance proposal will lower it to 250 |
| `revealWindow` | `300` (5 min) | 1 to 7 days | Lets you demonstrate `cancelCommitment` |
| `challengeWindow` | `60` (1 min) | 7 days | Full slash enforcement arc live |
| `votingPeriod` | `300` (5 min) | 3 to 7 days | At the floor. Full cycle demonstrable live |
| `executionDelay` | `300` (5 min) | 2 days | At the floor |
| `quorumBps` | `400` (4%) | 400 to 1000 | At the floor, easiest to reach solo |
| `proposalThreshold` | `0` | Market-dependent | Any staker may propose on testnet |

---

## Sepolia deployment

Order is dependency-driven. Record every address as you go.

### 1. AIMToken

```
stakingRewardsPool : <admin>
treasury           : <treasury>
team               : <admin>
investors          : <admin>
liquidity          : <admin>
```

Mints 1,000,000,000 AIM across the five addresses. No mint function exists afterwards.

### 2. ComplianceRegistry

```
admin : <admin>
```

Deploys before anything that needs it. No dependencies by design.

### 3. StakingVault

```
stakingToken     : <AIMToken>
admin            : <admin>
treasury_        : <treasury>
lockPeriod_      : 300
minProviderBond_ : 1000000000000000000000
```

### 4. ModelRegistry

```
admin         : <admin>
stakingVault_ : <StakingVault>
```

### 5. Marketplace

```
admin              : <admin>
paymentToken       : <AIMToken>
modelRegistry      : <ModelRegistry>
complianceRegistry : <ComplianceRegistry>
treasury_          : <treasury>
protocolFeeBps_    : 500
revealWindow_      : 300
```

### 6. PerformanceOracle

```
admin            : <admin>
stakingVault     : <StakingVault>
modelRegistry    : <ModelRegistry>
challengeWindow_ : 60
```

### 7. ParameterGovernor

The `targets` argument is a Solidity array. In Remix, enter it with square brackets:

```
admin              : <admin>
stakingVault       : <StakingVault>
targets            : ["<Marketplace>","<StakingVault>","<PerformanceOracle>","<ModelRegistry>"]
votingPeriod_      : 300
executionDelay_    : 300
quorumBps_         : 400
proposalThreshold_ : 0
```

The governor registers itself as a target automatically, which is what makes its own
setters reachable through a passed proposal and only that way.

### 8. RegistryGateway (Sepolia only)

```
admin         : <admin>
modelRegistry : <ModelRegistry>
```

---

## Role wiring

Nine transactions from `admin`. Role hashes are readable from each contract's public
constants, so call `SLASHER_ROLE()` and paste the returned bytes32 rather than computing it.

| # | Contract | Call |
|---|---|---|
| 1 | StakingVault | `grantRole(SLASHER_ROLE, <PerformanceOracle>)` |
| 2 | StakingVault | `grantRole(GOVERNOR_ROLE, <ParameterGovernor>)` |
| 3 | StakingVault | `grantRole(REWARD_FUNDER_ROLE, <admin>)` |
| 4 | ModelRegistry | `grantRole(GOVERNOR_ROLE, <ParameterGovernor>)` |
| 5 | Marketplace | `grantRole(GOVERNOR_ROLE, <ParameterGovernor>)` |
| 6 | PerformanceOracle | `grantRole(GOVERNOR_ROLE, <ParameterGovernor>)` |
| 7 | PerformanceOracle | `addReporter(<reporter1>)` |
| 8 | PerformanceOracle | `addReporter(<reporter2>)` |
| 9 | PerformanceOracle | `addReporter(<reporter3>)` |

Transaction 1 is the one that makes the oracle able to burn bonds. Without it,
`enforceSlash` reverts.

`CURATOR_ROLE` on `ModelRegistry` and `ATTESTOR_ROLE` on `ComplianceRegistry` stay with
`admin`, which is correct: those are operational roles, not governed ones.

If you have only one account, skip transactions 7 to 9 and instead call
`PerformanceOracle.setQuorum(1)`, then `addReporter(<admin>)`.

---

## Create the governance proposal now

The demo proposal lowers the marketplace fee from 5% to 2.5%.

**Step 1.** Stake, so you have voting weight. Voting power requires stake that predates the
proposal, so stake before proposing, not after.

```
AIMToken.approve(<StakingVault>, 100000000000000000000000)
StakingVault.stake(10000000000000000000000)        // 10,000 AIM
```

**Step 2.** Get the calldata for `setProtocolFeeBps(250)`. In Remix, open the Marketplace
instance, expand `setProtocolFeeBps`, enter `250`, and click the clipboard icon next to the
transact button to copy calldata without sending. It will be:

```
0x<selector><32-byte 250>
```

**Step 3.** Propose.

```
ParameterGovernor.propose(<Marketplace>, <calldata from step 2>)
```

**Step 4.** Vote immediately.

```
ParameterGovernor.castVote(1, 1)     // proposalId 1, VoteType.For
```

**Step 5.** Wait 10 minutes, being the 5-minute voting period plus the 5-minute execution
delay, then execute and screenshot both the transaction and `Marketplace.protocolFeeBps()`
returning 250.

```
ParameterGovernor.execute(1)
```

Check `state(1)` first. It should return `2` for Succeeded before you attempt execution.

---

## Amoy deployment

Switch MetaMask to Polygon Amoy. Deploy steps 1 through 5 only, being `AIMToken`,
`ComplianceRegistry`, `StakingVault`, `ModelRegistry` and `Marketplace`, then the receiver.
Skip `PerformanceOracle`, `ParameterGovernor` and all role wiring for the reasons given above.

### 8. RegistryReceiver (Amoy only)

```
admin   : <admin>
relayer : <admin>
```

Using `admin` as the relayer is fine on testnet and is what makes the manual relay possible.
Note in the documentation that production would separate these.

No role wiring is required on Amoy. `RELAYER_ROLE` is granted in the receiver's constructor.

---

## Contract verification

Verify all fourteen using Remix's **Contract Verification** plugin, or Etherscan and
Polygonscan directly. If time is short, verify the eight Sepolia contracts first: they carry
every demonstrated flow. `RegistryReceiver` on Amoy is the next priority, because a verified
receiver is what makes the manual relay possible through the explorer. Verification requires the exact constructor arguments, so keep the
values recorded above.

Verified contracts give you a clickable read and write interface on the explorer, which is
better demo evidence than a screenshot and is what makes the manual cross-chain relay
practical.

---

## The cross-chain relay

**On Sepolia**, register and attest a model:

```
AIMToken.approve(<StakingVault>, ...)
StakingVault.stake(2000000000000000000000)          // above minProviderBond
ModelRegistry.registerModel(<bytes32 CID>, 0)       // 0 = Minimal risk
RegistryGateway.attestModel(1)
```

For the CID, any bytes32 works on testnet. Use the keccak256 of an IPFS URI, or simply
`0x0000000000000000000000000000000000000000000000000000000000000001`.

**Read the event.** On Sepolia Etherscan, open the `attestModel` transaction and expand the
Logs tab. `ModelAttested` gives you six values: `nonce`, `modelId`, `provider`, `listable`,
`highRisk`, `attestedAt`.

**On Amoy**, deliver it. The receiver's parameters match the event field for field, so copy
them across unchanged:

```
RegistryReceiver.receiveAttestation(
  <nonce>, <modelId>, <provider>, <listable>, <highRisk>, <attestedAt>
)
```

**Confirm.** `RegistryReceiver.isMirroredListable(1)` returns true, and
`getMirroredModel(1)` shows the Sepolia provider address.

**Then propagate a change.** Suspend the model on Sepolia with
`ModelRegistry.suspendModel(1)`, attest again, relay again. `isMirroredListable(1)` becomes
false on Amoy. That second relay is the more convincing half of the demo, because it shows
state tracking rather than a one-off write.

### Screen-record this

Testnets go down and faucets run dry. Record the relay before submission day. A recording
plus verified contract links is stronger evidence than a live attempt that fails.

---

## Full demo sequence for the recording

Roughly 15 minutes.

1. **Staking.** Approve, stake, show `balanceOf` and `unlockAt`
2. **Registration.** `registerModel`, show `isListable` true
3. **Listing.** `createListing` at 1000 AIM
4. **Commit-reveal purchase.** `computeCommitment` off-chain, `commitPurchase`, then
   `revealPurchase`. Show the commit transaction revealing no model id, and the fee split
   landing in the treasury
5. **Oracle enforcement.** Three `submitScore` calls at 5000, `finalizeRound` showing
   flagged true, wait 60 seconds, `enforceSlash`, show the bond shrink and the treasury
   receiving tokens
6. **Cross-chain relay.** As above, both the initial mirror and the suspension propagation
7. **Governance.** Show the executed proposal and `protocolFeeBps` at 250
8. **Withdraw.** After `lockPeriod`, withdraw stake to show funds are never trapped

Steps 5 and 6 are the two that carry the most rubric weight. Give them the most screen time.

---

## Address record

Fill this in as you deploy. It goes into the README and the documentation.

| Contract | Sepolia | Amoy |
|---|---|---|
| AIMToken | | |
| ComplianceRegistry | | |
| StakingVault | | |
| ModelRegistry | | |
| Marketplace | | |
| PerformanceOracle | | |
| ParameterGovernor | | |
| RegistryGateway | | n/a |
| RegistryReceiver | n/a | |
