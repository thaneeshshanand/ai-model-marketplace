# AIMM Demonstration Record

**AI Model Marketplace (AIMM)**
Thaneesh Shanand Lingan Anandakumar
AAI 6850 Applied Blockchain AI, Northeastern University College of Professional Studies

Deployed and demonstrated 14 August 2026.

---

## 1. How to verify this yourself

Every claim in this document resolves to a transaction on a public testnet. Nothing here
requires taking my word for it, and nothing depends on a recording that could have been edited.
Each row in section 4 links to a block explorer where the sender, the decoded function call, the
arguments, the emitted events, and the timestamp are all visible.

The contracts are verified source, so the explorer renders a read and write interface. A
reviewer can call any view function on any contract and confirm current state independently.

**45 transactions across two testnets. Zero failures.**

---

## 2. Deployed contracts

### Ethereum Sepolia, chain 11155111

| Contract | Address |
|---|---|
| AIMToken | [`0x3E7BF65E1ddB0D12bA32AbBd6deC7521C222BFC6`](https://sepolia.etherscan.io/address/0x3E7BF65E1ddB0D12bA32AbBd6deC7521C222BFC6#code) |
| ComplianceRegistry | [`0x72dc13F9d76F1C459208E83ecC15005d36C82F92`](https://sepolia.etherscan.io/address/0x72dc13F9d76F1C459208E83ecC15005d36C82F92#code) |
| StakingVault | [`0x3Ab2424375C62b9c0432B9CE2f762257A09c4466`](https://sepolia.etherscan.io/address/0x3Ab2424375C62b9c0432B9CE2f762257A09c4466#code) |
| ModelRegistry | [`0x4A9d4dE720FF615ce78F356762b8bDeBced0b4eE`](https://sepolia.etherscan.io/address/0x4A9d4dE720FF615ce78F356762b8bDeBced0b4eE#code) |
| Marketplace | [`0x360fbD7917106D5a79f87F697F56CBf7df8Eb5e9`](https://sepolia.etherscan.io/address/0x360fbD7917106D5a79f87F697F56CBf7df8Eb5e9#code) |
| PerformanceOracle | [`0xB527429d042d222D901934CA25F3FE1dD156509C`](https://sepolia.etherscan.io/address/0xB527429d042d222D901934CA25F3FE1dD156509C#code) |
| ParameterGovernor | [`0x47748F5f27440FaF6409925BD5760470652aF357`](https://sepolia.etherscan.io/address/0x47748F5f27440FaF6409925BD5760470652aF357#code) |
| RegistryGateway | [`0xC695e15Edf1Af1e2752930D7bE241AD97F74ABFB`](https://sepolia.etherscan.io/address/0xC695e15Edf1Af1e2752930D7bE241AD97F74ABFB#code) |

### Base Sepolia, chain 84532

| Contract | Address |
|---|---|
| AIMToken | [`0x895311EFDB00f2262e4C108934AdeF113A1f7634`](https://sepolia.basescan.org/address/0x895311EFDB00f2262e4C108934AdeF113A1f7634#code) |
| ComplianceRegistry | [`0x720E17f695F291E860C209cEDc19185c9A32EE17`](https://sepolia.basescan.org/address/0x720E17f695F291E860C209cEDc19185c9A32EE17#code) |
| StakingVault | [`0x56328A20d560Ac8552C99C3c2A9aE31B2Fcc036a`](https://sepolia.basescan.org/address/0x56328A20d560Ac8552C99C3c2A9aE31B2Fcc036a#code) |
| ModelRegistry | [`0x6A6a71509cA6c0070a627c0bb75e550b528d8231`](https://sepolia.basescan.org/address/0x6A6a71509cA6c0070a627c0bb75e550b528d8231#code) |
| Marketplace | [`0x701019dB0a34e534cB9BDA7F2456aFbDb495bcda`](https://sepolia.basescan.org/address/0x701019dB0a34e534cB9BDA7F2456aFbDb495bcda#code) |
| RegistryReceiver | [`0x7ffb38Cdd23D7D046cd4c7B0Be4aB31Ff0Fc13C4`](https://sepolia.basescan.org/address/0x7ffb38Cdd23D7D046cd4c7B0Be4aB31Ff0Fc13C4#code) |

**14 deployments.** All verified on at least two independent sources: Etherscan or Basescan,
Sourcify, and Blockscout.

### Why the two chains differ

Base Sepolia carries six contracts rather than eight. `PerformanceOracle` and
`ParameterGovernor` are deployed on Ethereum Sepolia only, where both are fully demonstrated in
flows 4 and 5. Destination-chain role wiring was also skipped, because `RegistryReceiver` grants
`RELAYER_ROLE` in its constructor and no other role is exercised on the destination chain.

This is a deliberate scoping decision made to fit the submission window, not an incomplete
deployment. Both chains run an independently operable marketplace: token, staking, registry,
compliance, and marketplace. The cross-chain workflow needs only the gateway on the source side
and the receiver on the destination side.

### Note on the destination chain

The architecture documentation specifies Polygon Amoy as the destination chain. The deployment
uses **Base Sepolia** instead. Amoy's public RPC endpoints were unreachable from Remix during
the deployment window, as were Linea Sepolia and Arbitrum Sepolia. Base Sepolia connected on the
first attempt and verification succeeded immediately on all three explorers.

No contract code changed. Neither `RegistryGateway` nor `RegistryReceiver` contains a chain
identifier, which was a deliberate design property recorded in the architecture document before
this substitution became necessary. The relay mechanism, replay protection, stale-write guard,
and trust model are identical on any EVM chain.

---

## 3. Deployment parameters

Testnet values are short so every time-gated flow is demonstrable in one sitting. Production
recommendations are stated because the difference is a configuration decision, not a design
compromise.

| Parameter | Deployed | Production recommendation |
|---|---|---|
| `lockPeriod` | 300 s | 7 to 30 days |
| `minProviderBond` | 1,000 AIM | market-dependent |
| `protocolFeeBps` | 500, later 250 by governance | 250 to 500 |
| `revealWindow` | 300 s | 1 to 7 days |
| `challengeWindow` | 60 s | 7 days |
| `votingPeriod` | 300 s, at the floor | 3 to 7 days |
| `executionDelay` | 300 s, at the floor | 2 days |
| `quorumBps` | 400, at the floor | 400 to 1000 |
| `quorum` (oracle) | 1 | 3 or more |

Two of these are worth explaining rather than leaving to inference.

`quorum` is 1 because the demonstration ran from a single account. The contract enforces a cap of
`MAX_REPORTERS` (7) and the deviation guard operates identically at any quorum, but a single
reporter cannot demonstrate multi-reporter aggregation. That limitation is covered by the test
suite, which exercises three reporters, proportional aggregation, and deviation rejection.

`votingPeriod` and `executionDelay` sit exactly at their immutable floors of 300 seconds each.
The floors cannot be lowered by any proposal or any administrator, which is the structural
guarantee; the deployed value is a demonstration setting.

---

## 4. Flow record

| Flow | Action | Time UTC | Transaction | Verifiable result |
|---|---|---|---|---|
| 1 | Approve StakingVault | 09:30:00 | [`0xd9267823e6eddf...`](https://sepolia.etherscan.io/tx/0xd9267823e6eddf6091cc4c09c6ead89ba81b233cf8971142fbe749e2bf681d0e) | allowance set |
| 1 | Stake 10,000 AIM | 09:30:36 | [`0x9aef017c24b3d4...`](https://sepolia.etherscan.io/tx/0x9aef017c24b3d4249875ea2ba4705af169ef291b91249319d05e6ce9f5d594b4) | `isBondedProvider(provider)` -> true |
| 2 | Register model 1, Minimal risk | 09:40:24 | [`0x681163e054236e...`](https://sepolia.etherscan.io/tx/0x681163e054236e1d22b017e2474e00bbf0ae788fd651f01c25e4cb2374007f7d) | `isListable(1)` -> true |
| 2 | List model 1 at 1,000 AIM | 09:42:24 | [`0xb608d2094479eb...`](https://sepolia.etherscan.io/tx/0xb608d2094479eb815e367639497958d24e778fb78ab8d37ad3ad9bb9dc47fc5e) | `isPurchasable(1)` -> true |
| 3 | Approve Marketplace escrow | 10:50:12 | [`0xf08e75d489e660...`](https://sepolia.etherscan.io/tx/0xf08e75d489e660cccd8f223adc5df3e73355f9a27985c4b564b079320ade7474) | allowance set |
| 3 | Commit purchase, 2,000 AIM escrowed | 10:52:24 | [`0x629a01471cab20...`](https://sepolia.etherscan.io/tx/0x629a01471cab207545519667cd55f3125e891ff4a4e3a394abd84de7b502ac39) | `PurchaseCommitted` log contains no model id |
| 3 | Reveal and settle | 10:56:00 | [`0xcaf1672c50ff23...`](https://sepolia.etherscan.io/tx/0xcaf1672c50ff231c59f9778faeafe45a055465c3047bb83d515855f937b2e1d3) | `hasLicense(1,buyer)` -> true, 50 AIM fee |
| 4 | Submit benchmark score 5000 | 11:06:00 | [`0x7eab5df3bfc3d1...`](https://sepolia.etherscan.io/tx/0x7eab5df3bfc3d1cdd34c5301ae07b1fcc4e31b4bc0d02ecef171d820d2f909f4) | below the 6000 failure threshold |
| 4 | Finalize round 1 | 11:06:36 | [`0xd63504fb478fb4...`](https://sepolia.etherscan.io/tx/0xd63504fb478fb4ce3cbf6b65c5d29f2fcf5f0417bde314f97107eb01903eb540) | `flaggedAt` set, mean 5000 |
| 4 | Enforce slash after window | 11:19:48 | [`0x406c34daade159...`](https://sepolia.etherscan.io/tx/0x406c34daade159795cc57a30f6a5ca2bd01fcba864c656ee55a1565420c741e6) | bond 10,000 -> 9,000 AIM |
| 5 | Propose protocolFeeBps 500 -> 250 | 11:25:48 | [`0xe2cc0389c558f0...`](https://sepolia.etherscan.io/tx/0xe2cc0389c558f054f158863ba2a2ade4e63a573966bbbdef9e7733c8cd6cb0dc) | `state(1)` -> Active |
| 5 | Cast vote For | 11:27:12 | [`0x7648aebd8ecc86...`](https://sepolia.etherscan.io/tx/0x7648aebd8ecc869e0d131d452c23aba38783d2c88081c9a743330e8f919ab7b2) | weight 9,000 AIM |
| 5 | Execute proposal | 11:42:36 | [`0x20439cff68c79e...`](https://sepolia.etherscan.io/tx/0x20439cff68c79eb80081b78f6e7a4d45f8c6e7f3414f90b09d21ad71cc1fe007) | `protocolFeeBps()` -> 250 |
| 6 | Attest model 1, nonce 1 | 17:28:00 | [`0xf2adb5f27275cc...`](https://sepolia.etherscan.io/tx/0xf2adb5f27275cc25bf59aa82a6d9bfe4d94e01c9b8e5086bb7941b52078416ca) | `ModelAttested`, listable true |
| 6 | Relay nonce 1 to Base Sepolia | ~17:33 | `<hash pending>` | `isMirroredListable(1)` -> true, latency 332s |
| 6 | Suspend model 1 on source chain | 17:38:00 | [`0xefe6ab4042fa53...`](https://sepolia.etherscan.io/tx/0xefe6ab4042fa5328991bff715f4bc97749243c57d48ea4bf6f8dda1fe57ef859) | `isListable(1)` -> false |
| 6 | Attest model 1, nonce 2 | 17:39:36 | [`0x596306c313584e...`](https://sepolia.etherscan.io/tx/0x596306c313584e93d551bf3b73e2d6e6e3d8231aac74d58a5a49fcbe39fa8980) | `ModelAttested`, listable false |
| 6 | Relay nonce 2 to Base Sepolia | 17:42:18 | [`0x09a8bdc8285556...`](https://sepolia.basescan.org/tx/0x09a8bdc82855568b5054db6f18ca5df6ef58f0a873db4ea91b8894e334bf6d65) | `isMirroredListable(1)` -> false |

### The relay at nonce 1

Its transaction hash is not included above. The Base Sepolia CSV export was taken minutes after
the transaction and the explorer index had not yet caught up. Its occurrence is nonetheless
established by on-chain state: `RegistryReceiver.highestNonce()` returns **2**, and
`consumed(1)` returns **true**, neither of which is reachable without nonce 1 having been
delivered. The measured `syncLatency(1)` of 332 seconds at the time also matches the interval
between the nonce 1 attestation at 17:28:00 and its delivery.

The transaction is listed on the
[receiver's transaction history](https://sepolia.basescan.org/address/0x7ffb38Cdd23D7D046cd4c7B0Be4aB31Ff0Fc13C4)
alongside nonce 2.

---

## 5. What each flow demonstrates

### Flow 1, staking and bonding

Staking is not merely yield-bearing. The same balance serves three purposes simultaneously: it
earns accumulator-based rewards, it is the slashable bond that makes a provider's quality claim
credible, and it is governance voting weight. `lastIncreaseAt` is recorded at stake time and is
what makes flash-loan governance attacks structurally impossible.

### Flow 2, bond-gated listing

`registerModel` calls `StakingVault.isBondedProvider` and reverts otherwise. The risk tier is
self-declared by the provider, mirroring the EU AI Act conformity regime rather than assigning
tiers centrally. `RiskTier.Unacceptable` is rejected outright at registration.

### Flow 3, commit-reveal purchase privacy

**The precise claim:** the `PurchaseCommitted` event carries a digest, a buyer address, and an
escrow amount. It does not carry a model identifier. An observer of the commit transaction learns
that an address escrowed 2,000 AIM for something unspecified.

2,000 AIM was escrowed against a 1,000 AIM price deliberately. The 1,000 surplus refunds at
reveal, so the escrow amount does not reveal the price either.

What is not concealed is that a given address made a purchase, visible at reveal. Stating that
limit matters more than overstating the guarantee.

Settlement split the 1,000 AIM price into a 50 AIM protocol fee and 950 AIM to the provider,
with the 1,000 AIM surplus returned. All three transfers are visible in the reveal transaction's
logs.

### Flow 4, oracle data changing on-chain behaviour

The highest-value demonstration in this set. A score of 5000 against a 6000 failure threshold
flagged the round. After the 60-second challenge window lapsed unchallenged, `enforceSlash`
burned 10% of the provider's bond: **10,000 AIM became 9,000 AIM**, with 1,000 AIM transferred
to the treasury.

The `enforceSlash` transaction emits events from two contracts: `SlashEnforced` from
`PerformanceOracle` and `Slashed` from `StakingVault`. That cross-contract call is the mechanism
by which off-chain benchmark data destroys on-chain capital.

`isListable(1)` remained true afterwards, because 9,000 AIM is still above the 1,000 AIM
minimum bond. That is correct behaviour. The coupling is proven by the bond shrinking; driving it
below threshold would require eleven further slashes and demonstrates nothing additional.

**Not demonstrated on-chain:** the challenge-window guard rejecting premature enforcement. The
window elapsed before the attempt could be made. `enforceSlash` reverting with
`ChallengeWindowOpen` is covered by test, as is the provider's `challenge` path voiding a
flagged round.

### Flow 5, governance controlling a parameter

A proposal to change `Marketplace.protocolFeeBps` from 500 to 250 was created, voted on with
9,000 AIM of staked weight, and executed after the voting period and execution delay elapsed.
The fee is now 250 on-chain.

The execution transaction emits `ProposalExecuted` from the governor and `ParameterUpdated` from
the Marketplace. Governance modified state on a different contract through a low-level call
bounded to a construction-fixed target set.

### Flow 6, cross-chain provenance

Two relays, and the second is the more informative one.

The first mirrored a listable model from Ethereum Sepolia to Base Sepolia. The second followed a
suspension on the source chain: `suspendModel` on Sepolia, a fresh attestation at nonce 2, and
delivery to Base flipped `isMirroredListable(1)` from true to false.

That second relay demonstrates **state tracking rather than a one-off write**, which is the
difference between a mirror and a snapshot.

`syncLatency` computed correctly across two chains with independent clocks. The guard returning
zero rather than underflowing when the destination timestamp precedes the source was a defect
found and fixed during development, and no static analysis tool reported it.

---

## 6. Honest limitations

| Limitation | Why | Where it is covered |
|---|---|---|
| Single account for all roles | Only one funded wallet available | Roles are separately enforced and tested |
| Oracle quorum of 1 | Single account cannot reach a 3-reporter quorum | Tests exercise 3 reporters and aggregation |
| Base Sepolia instead of Polygon Amoy | Amoy, Linea and Arbitrum RPCs all unreachable | No code change; chain-agnostic by design |
| 6 contracts on Base, not 8 | Oracle and governor demonstrated on Sepolia | Deliberate scoping, stated in section 2 |
| Challenge-window rejection not shown on-chain | Window lapsed before the attempt | Covered by test |
| Time windows in seconds, not days | Demonstrability within one session | Production values in section 3 |
| Relayer is a single trusted account | No threshold signing implemented | Recorded as R-01 in the security audit |

None of these is concealed, and each is either covered by the test suite or recorded as accepted
risk in `SECURITY_AUDIT.md`.

---

## 7. Gas

| Chain | Transactions | Gas |
|---|---|---|
| Ethereum Sepolia | 38 | 0.039403 ETH |
| Base Sepolia | 7 | 0.000041 ETH |

Base Sepolia cost roughly 1/1000th of Ethereum Sepolia for comparable work, which is a
concrete illustration of the L2 economics that motivate a multi-chain deployment in the first
place.

---

## 8. Independent verification checklist

For a reviewer wanting to confirm the current state directly. Every one of these is a view call
on a verified contract, requiring no transaction and no wallet.

**On Sepolia StakingVault** `0x3Ab2424375C62b9c0432B9CE2f762257A09c4466`
- `balanceOf(0xb41c3b5788e24d51602003d49379b6bddd8aca96)` returns 9000000000000000000000, the post-slash bond
- `solvency()` returns held and owed, where held must be at least owed

**On Sepolia ModelRegistry** `0x4A9d4dE720FF615ce78F356762b8bDeBced0b4eE`
- `modelCount()` returns 1
- `isListable(1)` returns false, reflecting the Flow 6 suspension

**On Sepolia Marketplace** `0x360fbD7917106D5a79f87F697F56CBf7df8Eb5e9`
- `protocolFeeBps()` returns 250, changed by governance from 500
- `hasLicense(1, 0xb41c3b5788e24d51602003d49379b6bddd8aca96)` returns true
- `lifetimeFees()` returns 50000000000000000000

**On Sepolia PerformanceOracle** `0xB527429d042d222D901934CA25F3FE1dD156509C`
- `rounds(1, 1)` shows meanScore 5000, flaggedAt set, enforced true

**On Sepolia ParameterGovernor** `0x47748F5f27440FaF6409925BD5760470652aF357`
- `state(1)` returns 3, Executed

**On Base Sepolia RegistryReceiver** `0x7ffb38Cdd23D7D046cd4c7B0Be4aB31Ff0Fc13C4`
- `highestNonce()` returns 2
- `consumed(1)` and `consumed(2)` both return true
- `isMirroredListable(1)` returns false, matching the source chain
- `getMirroredModel(1)` returns the Sepolia provider address
