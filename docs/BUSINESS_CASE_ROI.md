# AIMM Business Case and ROI Analysis

**AI Model Marketplace (AIMM)**
Thaneesh Shanand Lingan Anandakumar
AAI 6850 Applied Blockchain AI, Northeastern University College of Professional Studies

---

## 0. A note on method

This analysis contains no cited market-size figures, and that is deliberate.

Third-party AI market forecasts vary by an order of magnitude between sources, are frequently
recycled without attribution, and could not be verified against primary sources during
preparation. Quoting one would produce a number that looks authoritative and cannot be
defended under questioning.

Instead this document builds a **unit-economics model from explicit assumptions**. Every figure
below is derived by arithmetic from a stated input. Where an input is uncertain, a sensitivity
range is given. A reader who disagrees with an assumption can substitute their own and
recompute, which is the property a business case actually needs.

All monetary figures are illustrative and denominated in USD-equivalent for readability. AIMM
settles in AIM tokens.

---

## 1. The problem

An enterprise procuring a third-party AI model faces three verification problems that current
marketplaces do not solve.

**Performance claims are unverifiable before purchase.** A vendor's published benchmark is
self-reported. The buyer has no way to distinguish a genuine result from a figure obtained on a
favourable evaluation set, and no recourse if production performance diverges. Contractual
remedies require litigation, which for a mid-size licence costs more than the licence.

**Provenance is unauditable.** When a model is retrained, fine-tuned, or its weights are
replaced, the buyer typically learns from a changelog the vendor controls. For a regulated
deployment this is a compliance gap: the EU AI Act requires providers of high-risk systems to
maintain technical documentation and post-market monitoring, and a buyer relying on vendor
attestation inherits an obligation they cannot independently evidence.

**Procurement intent leaks.** Which capabilities a firm is acquiring is competitively
sensitive. Existing marketplaces log purchases against corporate accounts, and public-ledger
alternatives make it worse by publishing it permanently.

The common thread: **the vendor is the sole source of truth about the vendor.**

## 2. What AIMM changes

| Problem | Mechanism | Enforcement |
|---|---|---|
| Unverifiable claims | Provider bonds capital; independent reporters score performance | Sub-threshold scores slash the bond and remove sellability automatically |
| Unauditable provenance | Every registration, metadata change, suspension and retirement is an immutable event | Cross-chain replication gives a second independent record |
| Compliance evidence | Self-declared EU AI Act risk tier on-chain; attestations with mandatory expiry | High-risk purchases require a valid attestation recorded at order initiation |
| Procurement leakage | Commit-reveal purchase; disclosure grants stored as hashes | The model is never published at commit; grants are unenumerable |

The mechanism that carries the most weight is the coupling between bond and sellability.
`ModelRegistry.isListable` consults `StakingVault.isBondedProvider` on every read, so a slashed
provider stops being able to sell without administrative action. Quality enforcement is not a
policy, it is arithmetic.

---

## 3. Revenue model

One revenue line: a protocol fee on settled licences, `protocolFeeBps`, capped at 20% by
`MAX_PROTOCOL_FEE_BPS` and set by governance. Deployed at 500 bps (5%), reduced to 250 bps
(2.5%) by the demonstration governance proposal.

Deliberately not monetised: listing fees, which suppress supply during the phase when supply is
the constraint; bond custody yield, since holding provider capital and earning on it creates a
conflict; and data resale, which contradicts the privacy position the platform is built on.

### Assumption set

| Input | Value | Basis and sensitivity |
|---|---|---|
| A1 Average licence price | $8,000 | Mid-market annual enterprise software licence band. Range $2,000 to $25,000 |
| A2 Protocol fee | 2.5% | Post-governance rate. Cap is 20% |
| A3 Licences per model per year | 2 to 3 year one, 6 mature | Non-rival good, so one model serves many buyers. Sustained frequency is the single most uncertain input in this model and is not evidenced. Range 2 to 20 |
| A4 Minimum provider bond | 1,000 AIM | Deployed parameter |
| A5 Reporter set | 3 to 7 | Contract cap is 7 |
| A6 Annual provider churn | 20% | Includes retirement and slashing below threshold |

### Per-model unit economics

Two cases, because a single figure would conceal how much rests on A3. The mature case uses
6 licences per model per year; the year-one case uses 2, which cold-start dynamics make more
likely before a buyer base exists.

```
MATURE STATE (A3 = 6)
Annual gross licence value per model = $8,000 × 6   = $48,000
Protocol revenue per model per year  = $48,000 × 2.5% = $1,200
Provider net per model per year      = $48,000 − $1,200 = $46,800

YEAR ONE (A3 = 2)
Annual gross licence value per model = $8,000 × 2   = $16,000
Protocol revenue per model per year  = $16,000 × 2.5% = $400
Provider net per model per year      = $16,000 − $400  = $15,600
```

The mature figure was labelled the base case in an earlier draft. It is more accurately a
target state, and treating it as a baseline would overstate first-year viability by a factor
of three.

The provider retains 97.5%. That ratio is the adoption argument, and it holds
structurally rather than comparatively: AIMM's revenue is a thin settlement fee, and the
verification work that would otherwise be priced into procurement is performed by bonded
reporters funded from that same fee. The bond is recoverable capital, not a charge. No
comparison to specific competitor take rates is offered, because those vary by platform and
tier and were not verified.

### Revenue at three scales

| Active models | Gross licence value | Protocol revenue at 2.5% | At 5% |
|---|---|---|---|
| 50 | $2.4M | $60,000 | $120,000 |
| 500 | $24M | $600,000 | $1.2M |
| 2,500 | $120M | $3.0M | $6.0M |

### Sensitivity, 500 active models

Varying the two most uncertain inputs, A1 and A3, at a 2.5% fee:

| Licences/model/yr → | 2 | 6 | 12 | 20 |
|---|---|---|---|---|
| **$2,000 price** | $50k | $150k | $300k | $500k |
| **$8,000 price** | $200k | $600k | $1.2M | $2.0M |
| **$25,000 price** | $625k | $1.9M | $3.8M | $6.3M |

Spread across the plausible range is roughly 125x. **Any single-point revenue projection for
this platform is not credible**, and the honest conclusion is that viability depends far more
on licence frequency than on price. That argues for prioritising buyer-side breadth over
premium listings, which is a strategy conclusion the model produces rather than one asserted
in advance.

---

## 4. Cost structure

### Build, actual

| Item | Effort |
|---|---|
| 9 contracts, ~2,400 lines Solidity with NatSpec | Phases 1 to 5 |
| 372 tests, 96.61% branch coverage | Concurrent |
| CI/CD, static analysis, coverage gating | Phase 0 |
| Documentation, security report, business case | Phase 6 |
| Deployment across two testnets, 16 instances | Phase 6 |

Direct cost was tooling and testnet gas, both effectively zero: GitHub Codespaces free tier,
Remix, faucet-funded testnets.

### Production readiness, estimated

Costs a real deployment would incur that this project did not.

**These figures have no verified basis.** Unlike the revenue model above, which derives every
number from a labelled assumption, the table below is order-of-magnitude judgement. Audit
pricing in particular varies by more than 3x between firms and depends on scope negotiation
that has not occurred. They are included because a business case that omits cost is useless,
and they are flagged because presenting them in the same format as derived figures would imply
a rigour they do not have. Break-even below is therefore computed across a range rather than
against a point estimate.

| Item | Estimate | Note |
|---|---|---|
| Independent security audit | $40,000 to $120,000 | Nine contracts, novel governance and oracle logic |
| Legal review, securities and data protection | $25,000 to $60,000 | Token classification and GDPR posture |
| Reporter network bootstrap | $50,000 first year | 3 to 7 operators, retainer plus infrastructure |
| Relayer infrastructure | $6,000/yr | Redundant nodes, monitoring, alerting |
| Liquidity provision | 100M AIM | Allocated, not expensed |
| **Total pre-launch cash** | **$121,000 to $236,000** | Excluding token allocations |

### Ongoing

| Item | Low | Mid | High |
|---|---|---|---|
| Reporter retainers | $30,000 | $50,000 | $90,000 |
| Relayer and monitoring | $4,000 | $6,000 | $12,000 |
| Contract operations, curation and attestation | $40,000 | $80,000 | $150,000 |
| Legal and compliance maintenance | $15,000 | $30,000 | $60,000 |
| **Total annual run rate** | **$89,000** | **$166,000** | **$312,000** |

The spread is roughly 3.5x. Break-even is stated against all three.

---

## 5. Break-even

**Break-even is expressed in annual settled licences, not active models.** Models do not
generate revenue; settled licences do. An earlier draft used models as the denominator, which
obscured the requirement: 1,660 models at two licences each is 3,320 licences, and stating it
that way makes the scale of the ask legible.

At $8,000 per licence and a 2.5% fee, the protocol earns **$200 per settled licence**.

| Annual run rate | Break-even licences/yr | Licences/week |
|---|---|---|
| Low, $89,000 | 445 | 9 |
| Mid, $166,000 | 830 | 16 |
| High, $312,000 | 1,560 | 30 |

Active models required is a derived figure, dependent on A3:

| Run rate | A3 = 2 (year one) | A3 = 3 | A3 = 6 (mature) |
|---|---|---|---|
| Low | 222 models | 148 | 74 |
| Mid | 415 models | 277 | 138 |
| High | 780 models | 520 | 260 |

Two observations the corrected denominator makes visible.

**Sixteen settled licences per week at the mid run rate is a concrete, testable target.** It is
also well beyond what the Phase 2 adoption goal of 100 licences achieves, which means the
platform is structurally loss-making through at least the first year. That is normal for a
two-sided marketplace and should be planned for rather than discovered.

**The pessimistic price case does not close at any plausible scale.** At $2,000 licences the fee
is $50, requiring 3,320 settled licences annually at the mid run rate. A platform serving that
segment cannot fund a curated reporter network at 2.5%, and the correct response is to raise the
fee toward the 20% cap or shrink the reporter set, not to chase volume. The 20% cap therefore
functions as a solvency backstop rather than merely a fairness limit, which is worth noting
because the cap was chosen as a provider protection and turns out to serve a second purpose.

### Token value accrual

Governance is stake-weighted, so influence over `protocolFeeBps`, `minProviderBond`, and
`slashBps` requires locked AIM. Slashed bonds route to the treasury, so quality failures
increase treasury holdings. Providers must hold and lock AIM to list at all.

Stated plainly: **AIM has no direct fee-burn or revenue-share mechanism.** Fees accrue to the
treasury, not to holders. Demand comes from provider bonding and governance participation, both
of which lock supply. Whether that supports a given valuation is outside what this analysis can
responsibly claim, and a fee-burn or staking-yield mechanism is a roadmap decision requiring
securities analysis before implementation, not an engineering one.

---

## 6. Adoption plan

The classic two-sided marketplace problem: buyers will not come without models, providers will
not bond without buyers.

**Phase 1, seed supply, months 1 to 6.** Recruit 20 to 40 providers directly, with bonds
subsidised from the treasury allocation for the first cohort. Target providers who already
publish benchmarks, since they lose nothing by having them verified. Success is 40 listed
models with an operating reporter network.

Two things about the subsidy that should not be glossed over. It costs **40,000 AIM** at 40
providers and the deployed 1,000 AIM minimum, drawn from the 250,000,000 AIM treasury
allocation, so it is 0.016% of treasury and financially trivial. But it **partially defeats the
mechanism**: a subsidised bond is not the provider's own capital at risk, so slashing a
first-cohort provider destroys treasury funds rather than theirs, and the credibility the bond
is meant to create is weakest for exactly the cohort whose quality is least known. The
mitigation is to make subsidised bonds non-renewable, so a provider must post their own capital
to remain listed past the first term. Whether the subsidy is worth accepting that weakness for
six months is a launch decision, not a design one.

**Phase 2, seed demand, months 4 to 12.** Target buyers for whom verification is the binding
constraint rather than a nice-to-have: regulated sectors deploying high-risk AI under the EU AI
Act, where independent provenance evidence has direct compliance value. The commit-reveal
privacy feature is a differentiator only for buyers who care about procurement confidentiality,
which correlates with the same segment. Success is 100 settled licences.

**Phase 3, decentralise governance, months 9 to 18.** Transfer `DEFAULT_ADMIN_ROLE` to a
multisig, then progressively to governance. Expand the reporter set toward the cap of 7 with
independent operators. Publish the parameter-change history as an operating record. Success is
governance executing parameter changes without administrative intervention.

**Phase 4, reduce trust assumptions, months 12 to 24.** Replace the permissioned relayer with
CCIP or a multi-signature attestation threshold, addressing R-01. Introduce reporter bonding,
addressing R-04. Add a challenge bond, addressing R-02.

The sequencing is deliberate: **trust reduction comes last, because it is the most expensive
and least urgent.** A platform with 40 models and a trusted relayer is useful. A trustless
bridge with no models is not.

---

## 7. Risks

### Business risks

| Risk | Impact | Mitigation |
|---|---|---|
| Cold-start failure | Fatal | Subsidised first-cohort bonds; target providers already publishing benchmarks |
| Reporter network cannot be recruited | Fatal to the value proposition | Quorum is governance-settable, so the platform can launch with 3 and scale |
| Licence frequency at the low end | Break-even unreachable | Fee is governance-adjustable to 20%; the cap doubles as a solvency backstop |
| Providers reject bonding | Supply-side blocker | Bond is recoverable capital, not a fee, and 97.5% revenue retention offsets the capital cost |
| Token classified as a security | Jurisdictional exclusion | No yield, no revenue share, no promise of appreciation. Legal review is a pre-launch line item |

### Technical risks

Carried forward from `SECURITY_AUDIT.md` section 5, with the business consequence attached.

| ID | Risk | Business consequence |
|---|---|---|
| R-01 | Trusted relayer can corrupt the Amoy mirror | Provenance claim weakened on one chain; Sepolia record unaffected |
| R-02 | Repeated challenge delays slashing | Enforcement credibility erodes if abused visibly |
| R-03 | Governance deadlock freezes parameters | Fee and bond levels become unadjustable; admin backstop exists |
| R-04 | Reporters unbonded | A colluding majority could slash honest providers |
| R-06 | Bond source repointable by governance | Captured governance could nullify bonding |

R-01 and R-04 are the two that materially weaken the pitch, and both have named Phase 4
remediations. The honest framing for an enterprise buyer is that AIMM's provenance guarantee is
stronger than vendor self-attestation and weaker than a trustless bridge, and that the Sepolia
record, which is the authoritative one, does not depend on the relayer at all.

### Regulatory

The EU AI Act imposes obligations on providers of high-risk systems including technical
documentation, record-keeping, and post-market monitoring. AIMM's self-declared risk tier and
immutable event history are designed to support those obligations, not to discharge them: the
platform provides evidence, the provider remains the obligated party. That distinction should
appear in provider terms of service, because a platform implying it discharges a provider's
regulatory duty is assuming liability it cannot bear.

On data protection, the design's position is that no personal data touches either chain. Only
hashes and pointers are stored. This avoids the collision between immutability and the right to
erasure rather than attempting to manage it.

---

## 8. Why blockchain

The question a sceptical reviewer should ask, answered directly. Three of the four mechanisms
genuinely require it; one does not.

| Mechanism | Requires a blockchain? |
|---|---|
| Bonded quality guarantees | **Yes.** Slashing must be automatic and beyond the platform operator's discretion. A centralised escrow that the operator can release defeats the purpose. |
| Immutable provenance | **Yes.** A vendor-controlled or platform-controlled log is exactly the trust assumption being removed. |
| Credible parameter governance | **Yes.** Stake-weighted voting with enforced timelocks cannot be replicated by a platform that can override its own policy. |
| Commit-reveal purchase privacy | **No.** A conventional database with access controls achieves this more cheaply. It is included because the settlement layer is already on-chain, and a public ledger would otherwise make privacy strictly worse than the centralised alternative. |

Being explicit that one of four does not need the technology is more credible than claiming all
four do.

---

## 9. Conclusion

Break-even requires roughly 830 settled licences a year, or 16 a week, against a mid-case
$166,000 run rate. Expressed in models that is 138 at mature licence frequency or 415 in year
one. The sensitivity analysis shows viability is driven far more by licence frequency than by
licence price, and the platform is structurally loss-making through at least its first year.

The defensible position is not a revenue forecast. It is that AIMM makes a specific,
mechanically enforced claim that no conventional marketplace makes: **a provider who
underperforms loses money and loses the ability to sell, automatically, without anyone
deciding.** Whether that is worth a 2.5% fee is a question the market answers. Whether the
mechanism works is a question the 372 tests and the audit report answer, and those answers are
verifiable today.

The largest genuine weaknesses are the trusted cross-chain relayer and the absence of reporter
bonding. Both are documented, both have named remediations, and neither is concealed in this
analysis or in the security report.
