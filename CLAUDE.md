# CLAUDE.md — APIX Live demo

Project guide for Claude Code sessions. **Read this first.**

## What this is
A self-contained, browser-based demo for an HL7 **Vulcan** talk that makes one
idea crystal clear: **PQI** (HL7 `uv-dx-pq`, Pharmaceutical Quality) authors
structured medicinal-product **content**; **APIX** (API Exchange for Medicinal
Products) is the FHIR-R5 **transport** that submits it, tracks it, and pushes
real-time updates. Storyline: a **US Prior Approval Supplement (PAS)** for
*Velexa 175 mg film-coated tablets* — add an **N-nitroso-velexate (NDSRI)** limit
and confirmatory LC-MS/MS test, where the limit is **computed** (acceptable intake
100 ng/day ÷ max daily dose 350 mg/day = 0.29 ppm). Audience is FHIR-literate (regulators, pharma, RIM vendors);
goal is clarity on stage with **real, valid R5** under the hood.

## Repository layout
- `index.html`, `styles.css`, `js/` — **active version** (light theme, 3 acts). This is what we evolve.
- `archive/v1/` — **frozen snapshot** of the approved foundation. Do not edit; reference baseline only.
- `README.md` — how to run + faithful-vs-simulated notes.
- `SCRIPT.md` — the 20-minute talk track.
- `CLAUDE.md` — this file.

## Run / deploy
No build, no npm, no backend. Open `index.html`, or `python3 -m http.server 8000`.
Drive with the **▶** button (presenter-paced). Deploy = any static host
(GitHub Pages from repo root, Netlify drop, etc.).

## Architecture (foundation)
Plain `<script>` files loaded in order; everything attaches to a global
`window.APIX`. **No ES modules** (they break under `file://`). Load order:
1. `js/highlight.js` — tiny JSON syntax highlighter
2. `js/codesystems.js` — APIX canonical systems + CodeSystems + `APIX.display()`
3. `js/seed.js` — Organizations, Endpoint, product (MPD), SubscriptionTopics, Subscription, supporting docs; `APIX.TASK_ID` / `TASK_UUID`
4. `js/pqi.js` — PQI engine: mocked source systems → `normalize()` → real `Bundle` (PlanDefinition + ObservationDefinitions); `renderSpecHtml()` (eCTD PDF view); `validate()`
5. `js/scenario.js` — ordered presenter-paced steps + `APIX.acts`
6. `js/store.js` — in-browser FHIR store + event bus ("the server"): `connect/submit/subscribe/updateTask`; builds Binaries + DocumentReferences (incl. dual-format spec) + Task; emits `task` / `notification` events
7. `js/app.js` — UI controller (3 acts, exchange channel, feedback loop, JSON peeks)

UI = 3 acts via a top stepper: **1 Author (PQI) → 2 Send (APIX) → 3 Review &
track**. Acts 2–3 share an Applicant | APIX channel | Regulator layout. Raw FHIR
lives behind **"View { }"** peeks, never a dominant column.

## FHIR fidelity notes (get these right)
- APIX exchanges a **`Task`** whose `input` → `DocumentReference` → `Binary`.
  **No `MedicinalProductDefinition` in APIX 0.1.0** — MPD is labeled "product context" only.
- Regulatory workflow lives in **`Task.businessStatus`** (CodeSystem
  `apix-business-status`), NOT `Task.status`. "Approved" = `status: completed` +
  `businessStatus: approved`. `Task.intent: proposal`; `code` from `apix-task-code`.
- Real-time = topic-based **`Subscription`** (`rest-hook`, `content: full-resource`,
  filter `Task.identifier`) → `Bundle type: subscription-notification` (first entry `SubscriptionStatus`).
- PQI (`uv-dx-pq`) drug-product spec = **`PlanDefinition`** (actions grouped by
  **Release** vs **End of shelf life**) → each test an **`ObservationDefinition`**
  (`code` + `method` + `qualifiedValue` text/range). Criteria adapted from the
  published example `bundle-drug-product-specification-pq-ex1`.
- Orgs: applicant **SynthPharma AG**; regulator generic **Health Authority**.
- Resources are valid R5 — Organization, MedicinalProductDefinition, and the PQI
  Bundle were POSTed to public `hapi.fhir.org/baseR5` and accepted (HTTP 201).

## Conventions & constraints
- **No build step, no npm, no CDNs, no ES modules.** Plain scripts → `window.APIX`.
  Must run from `file://` and from a static server.
- Light, presentation-grade theme; keep JSON behind peeks; presenter-paced single **▶** button.
- Keep resources spec-faithful; clearly flag simulated bits (OAuth, rest-hook delivery).

## Testing
- Syntax: `for f in js/*.js; do node -c "$f"; done`.
- Data/store integration (node): stub `global.window=global` and a
  `CustomEvent extends Event`, `eval` the data files in load order, then run
  `normalize → connect → submit → subscribe → updateTask` and assert
  (15 bundle entries, 7-doc payload, 4 notifications, final completed/approved).
- Cross-check `app.js` `el('id')` ids exist in `index.html`.
- Optional R5 validity: POST resources to `https://hapi.fhir.org/baseR5`.

## Roadmap — hardened "v2" (in progress)
Turning the scripted demo into an interactive sandbox. Pillars:
1. **Interactive authoring** — edit spec / choose variation; PQI Bundle + PDF regenerate live.
2. **Mock FHIR server with real request/response** — REST verbs, server ids +
   versioning, `OperationOutcome` on `$validate`, real SubscriptionTopic matching
   + delivery queue, clean request⇄response inspector. Refactor `store.js` →
   `MockFhirServer` behind a `Client` seam (so mock vs. real HAPI is a swap).
3. **Two-way conversation** — regulator *List of Questions* → applicant
   *response-to-questions* → decision branch (approve / request-info / reject);
   both sides subscribed.
4. **Audit + analytics** — `Provenance` per change + end-of-run cycle-time chart.

Under the hood: Task state machine + branching, `localStorage` persistence,
expanded tests. **Scope for the current iteration (see `PLAN.md`):
(A) ConceptMap-driven authoring + consolidated Document⇄FHIR toggle,
(B) Mock FHIR server + real I/O with live-HAPI seam,
(C) a spelled-out Industry⇄Health-Authority conversation.**

## Standards references
- APIX IG — https://build.fhir.org/ig/HL7/APIX---API-Exchange-for-Medicinal-Products/
- PQI (uv-dx-pq) — https://build.fhir.org/ig/HL7/uv-dx-pq/
- HL7 Vulcan — https://hl7vulcan.org/
