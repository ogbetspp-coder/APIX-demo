# PLAN — v2 hardening: ConceptMap authoring + mock FHIR server + spelled-out exchange

## Context
The v1 demo (frozen at `archive/v1/`) tells the right story, but (a) the
"harmonization" is invisible, (b) the "server" fakes the exchange with timeouts,
and (c) the back-and-forth, while nice, doesn't show *what* the two parties are
saying. This iteration makes the data-harmonization the visible star, hardens the
engine into a real request/response mock FHIR server, and turns the feedback loop
into a clearly narrated conversation. Guiding principle throughout: **brilliantly
simple, super clean.**

## Scope (this round)
**A. ConceptMap-driven authoring (Act 1).** Pull local terms from source systems →
animate harmonizing them via **`ConceptMap` / `$translate`** to PQI controlled
vocabularies (CodeableConcepts + UCUM) → assemble the FHIR Bundle → it "lands" as
one **consolidated specification** with a **Document ⇄ FHIR JSON toggle**. Then run
APIX from there.

**B. Mock FHIR server + real I/O (the engine).** Real `{request}→{response}` for
every interaction; the `$translate` calls in (A) run through this same server, so
harmonization and exchange share one believable backend. Clean I/O inspector.

**C. Spelled-out Industry ⇄ Health Authority conversation.** Keep the animation,
but show the notification, *who* sends to *whom*, and *what* they're communicating
(plain-language + the FHIR behind it), plus a running conversation log.

Out of scope (roadmap): free-form inline spec editing, regulator Q&A branching,
Provenance/analytics. Decision stays = approve.

## Goals
1. Harmonization is visible and real: local code → `ConceptMap $translate` → PQI
   CodeableConcept, animated row by row, driving the actual Bundle.
2. One consolidated spec view with a Document ⇄ FHIR toggle (no more twin buttons).
3. `MockFhirServer`: REST verbs, server ids, `meta.versionId`/`lastUpdated`,
   ETag/`If-Match`, conditional create, `$validate`→`OperationOutcome`,
   `ConceptMap/$translate`, realistic errors (404/412).
4. Real SubscriptionTopic matching + delivery queue (no hardcoded timeouts).
5. `FhirClient` seam: `mock` (default) + `hapi` (real fetch, optional) via `APIX.config.backend`.
6. Clean I/O inspector (collapsed, grouped, status-coded) — the act view stays the headline.
7. Conversation is explicit: every exchange shows from→to, a human sentence, and a "view { }" to the FHIR.

## Architecture (plain `<script>` → `window.APIX`, no build, file://-safe)
- `js/config.js` — `APIX.config = { backend:'mock', hapiBase:'https://hapi.fhir.org/baseR5' }`
- `js/terminology.js` — source local CodeSystems, PQI/UCUM target systems, and
  `ConceptMap` resources; `translate(system, code)` mirroring `$translate`. Supplies
  the mapping rows the Act 1 animation renders.
- `js/fhir-server.js` — `APIX.MockFhirServer`: `db` (Map `type/id` + history);
  `request(method,url,body,headers)` → `{status,headers,body}`; handlers for
  create/read/vread/update/search, `$validate`, `ConceptMap/$translate`, conditional
  create; topic engine (`evaluateTriggers`) + subscription registry + `deliver()`.
  Tiny hand-coded predicates for the two criteria we use (status-change; create+owner) — documented subset, no FHIRPath dep.
- `js/client.js` — `APIX.createClient(kind)` → `{ create, read, update, search, validate, translate, subscribe }`; `mock` wraps the server, `hapi` uses `fetch`; logs each call → emits `io` events.
- `js/agents.js` — `APIX.Applicant` + `APIX.Regulator`: high-level ops
  (`connect`, `harmonize`, `submitVariation`, `subscribe`; regulator
  `acknowledge/validate/assess/decide`) as client calls; each emits a
  conversation message `{from,to,kind,text,resourceRef}`.
- `js/pqi.js` (update) — `normalize()` uses `terminology.translate()` so
  ObservationDefinition codes/units are harmonized CodeableConcepts; exposes the
  ordered mapping steps for the animation.
- `js/app.js` (rewrite of Act 1 + exchange) — harmonization animation; consolidated
  Document⇄FHIR toggle; drives agents; renders the conversation + I/O inspector.
- `js/scenario.js` (update) — steps map to agent ops.
- Retire `js/store.js`. Unchanged: `highlight.js`, `codesystems.js`, `seed.js`.

## Act 1 UX — harmonize, then consolidate
1. **Pull**: terms stream in from 3 source systems; local codes highlighted.
2. **Harmonize**: a clean mapping panel fills row by row —
   `LIMS:WATER  →  ⟨ConceptMap⟩  →  PQI:Water Content`,
   `"% w/w" → UCUM:%`, etc. Each row is a real `$translate` call (visible in the
   I/O inspector). Simple, elegant, one row at a time.
3. **Consolidate**: harmonized concepts assemble into the FHIR Bundle, which lands
   as one **Consolidated specification** card with a **[ Document ] ⇄ [ FHIR ]**
   toggle (rendered eCTD 3.2.P.5.1 vs. the Bundle JSON), the one varied limit highlighted.
4. **→ run APIX** from this consolidated artifact.

## Exchange + conversation UX (spelled out)
- Applicant | APIX channel | Regulator, as today, but each message in the channel
  carries a label + a plain-language line, e.g.
  *"Health Authority → SynthPharma · 🔔 Notification: status is now Under Assessment."*
- A compact **conversation log** under the channel lists each exchange
  (from→to, sentence, `view { }`), so the audience can read the dialogue.
- Notifications visibly originate from the regulator action that caused them.

## Verification
- Node harness: drive harmonize→submit→subscribe→review through client/server;
  assert `$translate` returns a target Coding, creates → 201, update → version
  bump, `$validate` → OperationOutcome, topic match → delivery 200, final
  `completed`/`approved`.
- HAPI seam smoke: `backend:'hapi'`, create+read against `hapi.fhir.org/baseR5`.
- `app.js` id cross-check; `node -c` all files.

## Risks / notes
- No FHIRPath/terminology server → ConceptMaps and `$translate` are a small,
  documented, hand-authored subset (clearly labelled illustrative).
- Keep animation + inspector tasteful (clean, collapsed) — honour "no JSON wall."
- `archive/v1/` stays frozen as rollback.

## Compliance & evidence (NORTH STAR — full IG conformance, non-negotiable)
The audience is skeptical; the proof is conformance + real infrastructure.
- Every emitted resource validates against **FHIR R5** and the relevant IG
  profiles: APIX `hl7.fhir.uv.apix`, PQI `hl7.fhir.uv.pharm-quality`.
- Validate with the **official HL7 FHIR Validator** (`validator_cli.jar`) against
  the real IG packages; commit the output to `validation/` as evidence, and a
  `validate.sh` to re-run it. Aim: 0 errors (warnings triaged/justified).
- **ConceptMap + `$translate` exactly per R5** (build.fhir.org/conceptmap.html):
  use `group.element.target.relationship` (R5 — NOT R4 `equivalence`); `$translate`
  returns a `Parameters` with `result` + `match.relationship` + `match.concept`.
- Where APIX 0.1.0 has no profile (e.g. MedicinalProductDefinition), use base R5
  and label it — never claim conformance we don't have.

## Deployment (local-first; AWS optional)
_Per direction: a local setup is fine if it's credible — and it is. Conformance is
proven by the official validator, and the live seam runs against a **local
Dockerized HAPI R5**, so we can defeat the "it's fiction" claim with zero cloud.
AWS stays the preferred hosted option._

- **UI (static):** S3 + CloudFront. The app is pure static (no build), so
  `aws s3 sync` + a CloudFront invalidation. Ship `deploy/aws-static.md` + script.
- **Live seam (credibility):** a real **HAPI FHIR R5** server on AWS (ECS Fargate
  or EC2; `hapiproject/hapi`) **pre-loaded with the APIX + PQI IG packages**, CORS
  enabled — so the same UI flips `mock → hapi` and runs against real infrastructure.
  Ship `deploy/hapi-r5/` (compose + task definition + IG-load step). Note: AWS
  HealthLake is R4-only, so we use HAPI for R5.
- Posture: rehearse on the mock (stage-safe); keep the live AWS server one toggle
  away to defeat the "it's fiction" objection on demand.
