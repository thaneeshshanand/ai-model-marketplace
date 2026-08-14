# AI Model Marketplace (AIMM)

An enterprise marketplace for licensing AI models where quality claims are backed by capital
rather than by assertion.

Nine Solidity contracts deployed across two testnets. 372 tests, 100% statement coverage,
96.61% branch coverage, zero High or Critical findings from static analysis.

**AAI 6850 Applied Blockchain AI capstone**
Thaneesh Shanand Lingan Anandakumar
Northeastern University, College of Professional Studies

---

## The core idea

A model provider bonds AIM tokens to list a model. Independent reporters submit benchmark
scores. If aggregated performance falls below a governed threshold, the provider's bond is
slashed and the model loses sellability automatically.

The mechanism that makes this work is a single coupling: `ModelRegistry.isListable` consults
`StakingVault.isBondedProvider` on every read. A slashed provider stops being able to sell
without any administrative action, listing change, or human decision. **Quality enforcement is
arithmetic, not policy.**

Enterprises license models through a commit-reveal flow that keeps procurement decisions
private. Protocol parameters are controlled by stake-weighted governance. Model provenance
replicates across chains.

---

## Live deployments

All contracts are verified source, so each link below opens a working read and write interface.

### Ethereum Sepolia, chain 11155111

| Contract | Address |
|---|---|
| AIMToken | [`0x3E7BF65E…22BFC6`](https://sepolia.etherscan.io/address/0x3E7BF65E1ddB0D12bA32AbBd6deC7521C222BFC6#code) |
| ComplianceRegistry | [`0x72dc13F9…C82F92`](https://sepolia.etherscan.io/address/0x72dc13F9d76F1C459208E83ecC15005d36C82F92#code) |
| StakingVault | [`0x3Ab24243…9c4466`](https://sepolia.etherscan.io/address/0x3Ab2424375C62b9c0432B9CE2f762257A09c4466#code) |
| ModelRegistry | [`0x4A9d4dE7…d0b4eE`](https://sepolia.etherscan.io/address/0x4A9d4dE720FF615ce78F356762b8bDeBced0b4eE#code) |
| Marketplace | [`0x360fbD79…8Eb5e9`](https://sepolia.etherscan.io/address/0x360fbD7917106D5a79f87F697F56CBf7df8Eb5e9#code) |
| PerformanceOracle | [`0xB527429d…56509C`](https://sepolia.etherscan.io/address/0xB527429d042d222D901934CA25F3FE1dD156509C#code) |
| ParameterGovernor | [`0x47748F5f…2aF357`](https://sepolia.etherscan.io/address/0x47748F5f27440FaF6409925BD5760470652aF357#code) |
| RegistryGateway | [`0xC695e15E…74ABFB`](https://sepolia.etherscan.io/address/0xC695e15Edf1Af1e2752930D7bE241AD97F74ABFB#code) |

### Base Sepolia, chain 84532

| Contract | Address |
|---|---|
| AIMToken | [`0x895311EF…1f7634`](https://sepolia.basescan.org/address/0x895311EFDB00f2262e4C108934AdeF113A1f7634#code) |
| ComplianceRegistry | [`0x720E17f6…32EE17`](https://sepolia.basescan.org/address/0x720E17f695F291E860C209cEDc19185c9A32EE17#code) |
| StakingVault | [`0x56328A20…cc036a`](https://sepolia.basescan.org/address/0x56328A20d560Ac8552C99C3c2A9aE31B2Fcc036a#code) |
| ModelRegistry | [`0x6A6a7150…8d8231`](https://sepolia.basescan.org/address/0x6A6a71509cA6c0070a627c0bb75e550b528d8231#code) |
| Marketplace | [`0x701019dB…95bcda`](https://sepolia.basescan.org/address/0x701019dB0a34e534cB9BDA7F2456aFbDb495bcda#code) |
| RegistryReceiver | [`0x7ffb38Cd…0Fc13C4`](https://sepolia.basescan.org/address/0x7ffb38Cdd23D7D046cd4c7B0Be4aB31Ff0Fc13C4#code) |

Base Sepolia carries six contracts. `PerformanceOracle` and `ParameterGovernor` are on Ethereum
Sepolia only, where both are demonstrated. See `docs/DEMONSTRATION.md` for the scoping rationale.

---

## Architecture

```
                         ETHEREUM SEPOLIA
   AIMToken ──────────────┐
   fixed 1B, no mint      │ payment + stake
                          ▼
                    StakingVault ◄──── slash ──── PerformanceOracle
                    bonds, rewards                  benchmark rounds
                    voting weight                        ▲
                          │                              │
              isBonded    │                              │
              Provider    ▼                              │
                    ModelRegistry ────────────────────────┘
                    canonical listings
                          │        ▲
             isListable   │        │ attest
                          ▼        │
                     Marketplace   RegistryGateway
                     commit-reveal        │
                          ▲               │ ModelAttested
            isCompliant   │               │
                 ComplianceRegistry       │
                                          │
   ParameterGovernor ── GOVERNOR_ROLE ────┼─► 4 contracts
                                          │
                                 off-chain relayer
                                          ▼
                         BASE SEPOLIA: RegistryReceiver
                         mirror, advisory only
```

Full detail in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Contracts

| Contract | Purpose | Branch coverage |
|---|---|---|
| `AIMToken` | Fixed-supply ERC20, no mint function | 100% |
| `StakingVault` | Staking, rewards, bonds, slashing, voting weight | 95.83% |
| `ModelRegistry` | Model listings and lifecycle | 100% |
| `ComplianceRegistry` | Attestations and selective disclosure | 100% |
| `Marketplace` | Fixed-price licensing, commit-reveal privacy | 93.14% |
| `PerformanceOracle` | Benchmark aggregation, bond enforcement | 95.08% |
| `ParameterGovernor` | Stake-weighted parameter governance | 100% |
| `RegistryGateway` | Cross-chain attestation emitter | 100% |
| `RegistryReceiver` | Cross-chain registry mirror | 100% |

---

## Design decisions worth defending

**Voting weight comes from staked balance, not token balance.** `votingPowerAt` returns zero if
the account increased its stake at or after the proposal snapshot. A flash loan cannot
retroactively have existed, so vote buying within a transaction is structurally impossible and
no `ERC20Votes` checkpointing is needed. Beanstalk lost roughly $182M in April 2022 to exactly
the attack this prevents.

**No mint function anywhere.** The entire supply is minted in the constructor and `_mint` is
never reachable again. No owner, no minter role, no upgrade path.

**Commit-reveal protects the buyer, not the price.** The privacy problem is not price discovery,
it is that a public purchase event leaks which enterprise is procuring which capability. The
`PurchaseCommitted` event carries a digest, a buyer, and an escrow amount, and no model
identifier.

**No personal data on-chain, ever.** Attestations record that an off-chain verification happened,
identified by document hash only. A public immutable ledger and the GDPR right to erasure are
incompatible, so the design avoids the conflict rather than managing it.

**Slashing is gated by a challenge window and capped per call.** Benchmarks are noisy, so a
flagged provider can void a round before any bond burns. The vault caps any single slash at 50%
of the target's stake, bounding the damage a compromised oracle could do.

**Pause never traps user funds.** Pausing blocks new stakes and new commits. Withdrawals, reward
claims, reveals and cancellations stay open by design.

**Mean with a deviation guard, not median.** Median aggregation defends against outliers in an
open reporter network. This set is permissioned and capped at 7, so outlier resistance already
comes from access control. Sorting on-chain would add gas and branches against a threat the
access model handles.

Nine things deliberately **not** built, with reasons, are listed in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) section 7.

---

## Testing

```bash
npm install
npm run verify      # lint, compile, test, coverage
npm run slither     # static analysis
```

| Metric | Result |
|---|---|
| Tests | 372 passing |
| Statements | 100% |
| Branches | 96.61% |
| Functions | 100% |
| Lines | 100% |

Branch coverage is treated as the governing metric rather than statement coverage. Statements hit
100% while five decision paths were still unexercised, so the higher number was the less
informative one.

Every custom error in every contract has at least one test asserting it, verified mechanically
before each build stage was accepted.

---

## Security

37 Slither findings across 7 detectors, **none High or Critical**, all individually triaged in
[`docs/SECURITY_AUDIT.md`](docs/SECURITY_AUDIT.md).

One Medium finding was fixed rather than justified: `divide-before-multiply` in the oracle's
deviation guard, eliminated by restructuring the comparison to remove division entirely, with
equivalence verified across an exhaustive sweep.

The report also records **eight manual-review findings that no tool reported**, including the
trusted cross-chain relayer, the absence of reporter bonding, and the administrative backstop on
governance. Those are the material risks, and each carries its inherent severity, the controls
that bound it, and what would remove it.

---

## Development environment

Reproducible via devcontainer. No local installation required.

```
Node 22.16.0 · Python 3.11.15 · Slither 0.11.6
Hardhat 2.29.0 · solc 0.8.24 (EVM target: paris) · solidity-coverage 0.8.17
```

Open in GitHub Codespaces and the container installs everything, including Slither, on creation.

`evmVersion` is pinned to `paris` rather than the 0.8.24 default of `cancun`, so identical
bytecode deploys on any EVM chain regardless of how recently it forked. That choice is what made
substituting the destination chain a configuration change rather than a rebuild.

CI runs on every push: lint, compile, test, coverage, and Slither, with the coverage report and
Slither JSON published as downloadable artifacts.

No private key exists anywhere in this repository. Testnet deployment was performed from Remix
via MetaMask, and `hardhat.config.js` declares no network beyond the built-in Hardhat one.

---

## Documentation

| Document | Contents |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Topology, contract specs, user flows, privilege map, monitoring signals |
| [`docs/SECURITY_AUDIT.md`](docs/SECURITY_AUDIT.md) | Slither triage, manual findings, residual risk register |
| [`docs/BUSINESS_CASE_ROI.md`](docs/BUSINESS_CASE_ROI.md) | Unit economics, break-even, adoption plan, risks |
| [`docs/DEMONSTRATION.md`](docs/DEMONSTRATION.md) | Every flow with transaction links and a verification checklist |
| [`DEPLOYMENT.md`](DEPLOYMENT.md) | Deployment order, constructor arguments, role wiring |

---

## Repository layout

```
contracts/            9 production contracts
contracts/mocks/      3 test-only doubles, excluded from coverage
test/                 372 tests across 6 suites
docs/                 architecture, security, business case, demonstration
.devcontainer/        reproducible environment
.github/workflows/    CI pipeline
```

---

## Deployment parameters

Testnet values are short so every time-gated flow is demonstrable in one session. The immutable
floors guarantee the delays can never reach zero; the deployed values are demonstration settings.

| Parameter | Deployed | Production recommendation |
|---|---|---|
| `lockPeriod` | 300 s | 7 to 30 days |
| `minProviderBond` | 1,000 AIM | market-dependent |
| `protocolFeeBps` | 250, lowered from 500 by governance | 250 to 500 |
| `revealWindow` | 300 s | 1 to 7 days |
| `challengeWindow` | 60 s | 7 days |
| `votingPeriod` | 300 s, at the floor | 3 to 7 days |
| `executionDelay` | 300 s, at the floor | 2 days |

---

## Known limitations

Stated here rather than left to be discovered.

- **The cross-chain relayer is a single trusted account.** Not a trustless bridge. The
  consequence is bounded: `RegistryReceiver` writes only its own mirror and holds no role on any
  other contract, so a compromised relayer corrupts advisory destination-chain state and nothing else.
  Recorded as R-01.
- **Oracle reporters have nothing at stake.** Mitigated by governance-controlled admission, the
  deviation guard, and the challenge window. Reporter bonding is roadmap. Recorded as R-04.
- **A provider can repeatedly challenge to delay enforcement.** No challenge bond or strike
  counter. Recorded as R-02.
- **Governance deadlock would freeze parameters on four contracts.** `DEFAULT_ADMIN_ROLE`
  remains with the deployer as break-glass, which is genuine centralisation. Recorded as R-03.
- **Interfaces are declared locally by consumers rather than inherited by implementations.**
  Slither finding F-07, accepted because the test suite exercises every cross-contract call
  against real implementations.

---

## Licence

MIT
