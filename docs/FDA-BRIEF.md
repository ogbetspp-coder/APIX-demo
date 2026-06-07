# APIX × PQI — one-page brief (for FDA review)

**What it is.** A runnable reference demo: structured pharmaceutical-quality
content (**PQI**, HL7 `uv-dx-pq`) carried by an **API-first FHIR R5 transport**
(**APIX**, HL7 Vulcan's *API Exchange for Medicinal Products*), with real-time
status tracking. It runs on a real **HAPI FHIR R5** server and its resources pass
the **official HL7 FHIR Validator** against the APIX + PQI IGs.

**The scenario.** A US **Prior Approval Supplement** to a finished-product
specification (add an **N-nitroso-velexate (NDSRI)** limit + LC-MS/MS test) for a
solid-oral-dose tablet — i.e., a **computable ICH Q12 Established-Condition
change** where the limit is **derived** from acceptable intake (100 ng/day) ÷
maximum daily dose (350 mg/day) = 0.29 ppm — a calculation a PDF cannot do.

**Approach — two complementary halves.**
- **PQI / PQ-CMC = content.** The spec is a FHIR `PlanDefinition` + `ObservationDefinition`s (test · method · acceptance criterion), rendered both as an eCTD 3.2.P.5.1 document and as the structured Bundle.
- **APIX = transport + state + real-time.** Submission as `Task` → `DocumentReference` → `Binary`; regulatory workflow in `Task.businessStatus`; real-time via topic-based `Subscription` (WebSocket on self-hosted HAPI).

**Where it fits at FDA (alignment, not endorsement).**
- **PQ-CMC FHIR IG** (FDA-funded, R5, eCTD Module 3, *solid-oral-dose scope*) — our product is in scope; same FHIR version and HL7 BR&R work group. *(STU/draft, voluntary.)*
- **KASA** (CDER/OPQ, **in production** for generic SODF) — structured specs are the kind of input structured assessment consumes.
- **ICH Q12** (final FDA guidance) — the new NDSRI limit is an Established-Condition change.
- **IDMP guidance (2023), SPL, GSRS/UNII, openFDA** — PQI is a FHIR-native expression of product/substance data FDA already standardizes.
- **TMAP/DMAP/EMAP** — APIX-over-FHIR matches FDA's stated commitments to "external data interfaces," "industry standards," and "interoperable" exchange.
- **ESG NextGen** (REST submit/status/acknowledge, 2025) — APIX is a FHIR-native rendering of that submit-and-track pattern. **eCTD v4.0** two-way (agency→sponsor) communication is a *planned* phase; the demo's question loop models it.

**What is real vs. simulated (the honesty line).** FDA has **not** adopted FHIR as a
submission transport; **APIX is pre-ballot (IG v0.1.0, STU target Jan 2027)**; FDA
is **not** a named APIX participant (it **is** a named contributor to Vulcan's
**ePI** profile, with EMA + PMDA). **Real in the demo:** valid FHIR R5 resources;
real REST + `$validate` + `$translate` + Subscriptions against HAPI R5; official-
validator conformance; FHIR `Provenance` audit trail. **Simulated/labeled:** SMART
Backend Services OAuth2 token, rest-hook delivery (WebSocket/read-back used),
e-signature. Maturity: **KASA = production · PQ-CMC = STU · QMM = voluntary
prototype · APIX = pre-ballot.**

**Architecture.** Browser FHIR client → **HAPI FHIR R5** (`deploy/hapi-r5`, Docker;
subscriptions + CORS; PQI IG loaded, APIX IG loadable). Clean client/server seam
(Mock ⇄ Local HAPI ⇄ public HAPI). No build step; plain FHIR over HTTPS.

**Security (architecture; simulated in demo).** APIX's intended model is **SMART
Backend Services** — OAuth2 client-credentials with a signed JWT client assertion,
scoped system tokens, TLS; attribute-based access by Organization. The demo labels
the token exchange as simulated. *(Roadmap: real token flow against the local HAPI.)*

**Conformance & data integrity.** `./validation/validate.sh` runs the official HL7
validator against FHIR R5 + the real APIX (CI) and PQI (v1.0.0) IGs: **7/8 resource
types clean; the single residual is a documented contradiction inside the APIX 0.1.0
draft IG** (a slice pattern vs. CodeSystem display), not a demo defect. A FHIR
`Provenance` is recorded per Task transition (who/what/when/why) — the audit trail
**21 CFR Part 11 / ALCOA** require.

**Run it.** `python3 -m http.server` then open the UI (Mock, offline) · or
`cd deploy/hapi-r5 && docker compose up -d && ./seed.sh` for the live HAPI R5 path.

**Sources.** See `docs/FDA-ALIGNMENT.md` (cited: PQ-CMC IG, PQI IG, KASA, ICH Q12,
IDMP guidance, SPL, GSRS, TMAP/DMAP/EMAP, BEST, ESG NextGen, eCTD v4.0, 21 CFR
Part 11 / data-integrity guidance, RTOR, Project Orbis, APIX/ePI).

---
*Illustrative reference demo for HL7 Vulcan. Product, organizations, and figures are
fictional. "Directional alignment with FDA's stated direction" — not an FDA roadmap
or endorsement.*
