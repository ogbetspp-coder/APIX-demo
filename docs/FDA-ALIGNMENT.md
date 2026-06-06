# FDA Alignment — research synthesis & demo-tailoring plan

Purpose: tailor the APIX × PQI demo for a **senior FDA IT** audience. Every
alignment claim below is sourced; the guardrails exist because, with this
audience, one inaccurate claim costs all credibility.

**Bottom line.** The demo's thesis — *structured pharmaceutical-quality content
(PQI / PQ-CMC) carried by an API-first FHIR-R5 transport with real-time tracking
(APIX)* — is **directionally exactly where FDA is already moving**. FDA has built
the *content* half and a *structured-assessment* engine; an APIX-style transport
is the **not-yet-built** half. Position the demo as *"the transport half, in
FHIR, aligned with what you've already shipped"* — never as "FDA's plan."

---

## A. Where FDA actually is (the synthesized picture)
- **Digital/data strategy, in FDA's own words:** TMAP (2019) → DMAP (2021) → EMAP (2022) commit FDA to "external data interfaces," cloud, cybersecurity, "adoption of industry standards," "interoperable" external collaboration, and "consistent, repeatable data practices."
- **Structured product/substance master data is already live:** the IDMP "Implementation and Use" guidance (Mar 2023); SPL (HL7 XML, required since 2005); GSRS/UNII (ISO 11238, 200k+ substances); public openFDA REST/JSON APIs.
- **Structured CMC content is being standardized in FHIR R5 now:** the **FDA-funded PQ-CMC FHIR IG** (US realm, STU2 v2.0.0, 2025), targeting eCTD Module 3 / 2.3 — **currently Solid Oral Dosage Forms (SODF) only**, voluntary/for-comment, not mandatory.
- **Structured assessment is in production:** **KASA** (CDER/OPQ) has done **1,130+ structured assessments of generic non-sterile SODF since Feb 2021**, replacing narrative with structured data + FMECA risk models.
- **FHIR is already piloted at FDA:** the **BEST** initiative uses FHIR for post-market safety surveillance; an **Apr 2025 docket** explores FHIR for real-world study data.
- **Submission transport is REST, not FHIR:** **ESG NextGen** went live Apr 2025 with submit/status/acknowledge **REST APIs** (not FHIR, not yet the default). **eCTD v4.0** accepted for new apps since Sept 2024; its **agency→sponsor two-way communication is a *planned* future phase** (~mandatory v4.0 around 2029).
- **Lifecycle & harmonization:** ICH **Q12** finalized at FDA (2021) — Established Conditions (EC), PACMP, PLCM. FDA is an ICH founding member; **Project Orbis** enables concurrent multi-regulator oncology review (reliance, not mutual recognition). **RTOR** showed structured, earlier review actioned ~90% of applications before PDUFA.
- **Data integrity:** 21 CFR Part 11; the 2018 data-integrity guidance defines **ALCOA** and an audit trail as the **"who/what/when/why"** of a record.

## B. Accurate alignment anchors — lead with these (all citable)
| Anchor | What we say | Maturity |
|---|---|---|
| **PQ-CMC FHIR IG** (FDA-funded, R5, Module 3) | "Same FHIR R5, same BR&R work group, same structured-spec model as FDA's own IG." Velexa = **SODF → in scope.** | STU2 / draft |
| **KASA** | "Our structured `PlanDefinition`+`ObservationDefinition` spec is the structured input KASA consumes." | **Production (SODF)** |
| **ICH Q12 Established Conditions** | "Our Water-Content variation is a *computable* EC change — old range → new range on a named test." | Final guidance |
| **IDMP guidance / SPL / GSRS / openFDA** | "PQI is the FHIR-native expression of product/substance data FDA already standardizes." | Production |
| **TMAP/DMAP/EMAP** | "APIX-over-FHIR = the 'external data interfaces / industry standards / interoperable' posture FDA committed to." | Published plans |
| **BEST + Apr-2025 FHIR docket** | "FHIR for regulatory data isn't hypothetical at FDA." | Pilot / exploratory |
| **ESG NextGen REST API** | "APIX is the FHIR-native rendering of an ESG-NextGen-style submit-and-track API." | Production (REST) |
| **eCTD v4.0 two-way comms** | "Our regulator→industry question loop = what v4.0 two-way comms aimed to deliver — but FDA **removed** two-way comms from current scope, so structured in-band messaging has no production home today." | Removed / deferred |
| **Part 11 / ALCOA** | "`Task`+`businessStatus`+versioning+`Provenance` = the who/what/when/why audit trail by design." | Regulation |
| **RTOR / Project Orbis / reliance** | "One valid R5 payload, many sovereign regulators — structured data > narrative." | Program / pilot |

## C. Guardrails — do NOT overclaim (this is what wins the room)
- **FDA does not accept FHIR *submissions* in production.** PQ-CMC is a draft, voluntary *content* standard; there is no live FDA FHIR submission endpoint.
- **APIX is pre-ballot (IG v0.1.0; STU target Jan 2027). FDA is *not* a named APIX participant.** (FDA *is* a named contributor to Vulcan's **ePI** profile, with EMA + PMDA — use that for the FDA-engagement point.)
- **Structured CMC is voluntary/for-comment, not mandatory.** Don't imply a requirement.
- **Don't conflate FDA "real-time"** (receipt-acknowledgement; RTOR *human* review) **with APIX topic-based `Subscription` push.**
- **Maturity precision:** KASA = production (SODF) · PQ-CMC = STU · QMM = voluntary prototype · eCTD v4.0 two-way = planned · APIX = pre-ballot.
- **ALCOA** is FDA's exact wording; **ALCOA+** is the broader GxP convention.
- PQI/PQ-CMC live under HL7 **BR&R**; **APIX** is the **Vulcan** accelerator project — don't blur them.
- Don't conflate the FDA **CDRP** review pilot (2022) with FHIR structured data.

## D. Demo-tailoring plan (concrete)
1. **FDA-accurate framing** in the UI + script: a "Where this fits at FDA" note naming PQ-CMC, KASA, ICH Q12 ECs, IDMP/SPL/GSRS, ESG NextGen, TMAP/DMAP; recast the variation as a **Q12 Established-Condition change**; call out **Velexa = SODF** (PQ-CMC scope). One honesty line per the guardrails.
2. **Audit / 21 CFR Part 11:** emit a `Provenance` per `Task` transition + an audit view, framed to the "who/what/when/why" + ALCOA — "audit-trail by design."
3. **Conformance to FDA's own IG:** validate (a PQ-CMC-shaped variant of) the spec against `hl7.fhir.us.pq-cmc-fda`, alongside the existing PQI validation — speak to *their* IG, not only the universal one.
4. **"Computable EC change → structured assessment" beat:** show the spec delta (range→range) as machine-computable input that could feed a KASA-style FMECA risk delta / Q12 EC review — connect our validation teeth to FDA's structured-assessment vision.
5. **Real-vs-Simulated** updated with the maturity gradient above.
6. **Deliverables:** an FDA-tailored `SCRIPT.md` (20 min) + a one-page leave-behind brief (standards, architecture, security, conformance, the honesty line, citations).

## Sources (primary first)
PQ-CMC IG https://build.fhir.org/ig/HL7/FHIR-us-pq-cmc-fda/ · PQI IG https://hl7.org/fhir/uv/pharm-quality/ ·
KASA https://pmc.ncbi.nlm.nih.gov/articles/PMC6733282/ , https://link.springer.com/article/10.1186/s41120-025-00141-3 ·
ICH Q12 https://www.federalregister.gov/documents/2021/05/12/2021-09963/ ·
IDMP guidance https://www.fda.gov/media/166736/download · SPL https://www.fda.gov/industry/fda-data-standards-advisory-board/structured-product-labeling-resources · GSRS https://gsrs.ncats.nih.gov/ ·
TMAP https://www.fda.gov/about-fda/reports/fdas-technology-modernization-action-plan · DMAP https://www.fda.gov/about-fda/reports/data-modernization-action-plan · EMAP https://www.fda.gov/about-fda/office-digital-transformation/enterprise-modernization-action-plan ·
BEST (FHIR) https://www.ncbi.nlm.nih.gov/pmc/articles/PMC11260708/ · FHIR RWD docket https://www.federalregister.gov/documents/2025/04/23/2025-06967/ ·
ESG NextGen https://www.fda.gov/industry/electronic-submissions-gateway-next-generation-esg-nextgen · eCTD v4.0 https://www.fda.gov/drugs/electronic-regulatory-submission-and-review/electronic-common-technical-document-ectd-v40 ·
Part 11 https://www.ecfr.gov/current/title-21/chapter-I/subchapter-A/part-11 · Data integrity/ALCOA https://www.fda.gov/regulatory-information/search-fda-guidance-documents/data-integrity-and-compliance-drug-cgmp-questions-and-answers ·
RTOR https://www.fda.gov/about-fda/oncology-center-excellence/real-time-oncology-review · Project Orbis https://www.fda.gov/about-fda/oncology-center-excellence/project-orbis ·
APIX https://hl7vulcan.org/projects/api-exchange-for-medicinal-products-apix/ · ePI (names FDA) https://hl7.github.io/emedicinal-product-info/

_Sourcing note: several fda.gov PDFs/Federal Register pages block automated fetch; those claims are corroborated across FDA-domain search text + secondary legal/industry analyses. Confirm any verbatim on-stage quote against the live FDA page._
