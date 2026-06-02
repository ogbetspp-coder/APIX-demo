# APIX Live — Pharmaceutical Quality Variation Demo

A self-contained, zero-install browser demo for an HL7 Vulcan talk. It makes one
idea **crystal clear**:

> **PQI** (HL7 *uv-dx-pq*, Pharmaceutical Quality) produces the structured
> **content**. **APIX** (API Exchange for Medicinal Products) is the **transport**
> that carries it, tracks it, and notifies both sides in real time — over the
> same rails whether the payload is a PDF **or** structured FHIR.

The storyline is a **routine Type IB specification variation** for *Velexa 175 mg
film-coated tablets*: tighten the end-of-shelf-life Water Content limit
(2.0% → 1.5% w/w).

## Run it

No build, no npm, no server required.

```bash
# simplest: just open the file
open index.html          # macOS   (or double-click it)

# or serve it (recommended; avoids any file:// quirks)
python3 -m http.server 8000   # then visit http://localhost:8000
```

Drive the demo with the **▶ button** at the bottom — one beat per click. **Reset**
restarts. Click any line in the **FHIR wire** to expand the real R5 JSON. The
📄 / `{ }` buttons open the rendered eCTD PDF and the structured FHIR bundle.

## What you're seeing (steps → FHIR)

**Act 1 — PQI authors the content**
1. **Pull** — spec data from 3 mocked source systems (LIMS / stability / methods)
2. **Normalize** — to the real PQI structure: a `PlanDefinition` (Release + End-of-shelf-life groups) where each test is an `ObservationDefinition`
3. **Render** — the same structured spec as **both** an eCTD 3.2.P.5.1 **PDF** and a PQI **FHIR Bundle**

**Act 2 — APIX exchanges & tracks it** (the canonical five steps)
4. **Connect** — register `Organization` + `Endpoint`, SMART Backend Services token
5. **Submit** — each document streamed as `Binary`, described by a `DocumentReference` (the spec appears **twice** — `application/pdf` *and* `application/fhir+json`), orchestrated by a `Task`
6. **Subscribe** — a topic-based `Subscription` on Task status changes
7–10. **Track** — the regulator advances the `Task` (`received → accepted → in-progress → completed`); the workflow lives in `Task.businessStatus`; each change pushes a real-time notification `Bundle` that drives the applicant's tracking timeline. At **Validate**, the reviewer can open the PDF *or* machine-check the structured acceptance criteria.

## Faithful vs. simulated

- **Faithful (real FHIR R5):** resource shapes are modelled on the published APIX
  and `uv-dx-pq` IG examples — `Task` + `businessStatus`, `DocumentReference` →
  `Binary`, topic-based `Subscription`, `subscription-notification` `Bundle`, and
  the `ObservationDefinition`-based PQI specification. These resources were
  **POSTed to a public HAPI FHIR R5 server and accepted (HTTP 201)** during the
  build — they are valid R5, not mock-ups.
- **Simulated (for stage reliability):** the "server" is an in-browser store
  (`js/store.js`); OAuth2 and the rest-hook delivery are emulated and clearly
  labelled; spec criteria are adapted from the published PQI example for legibility.

## Optional — run it against a real HAPI server

The data layer sits behind one small surface (`connect / submit / subscribe /
updateTask` on `APIX.store`). To go live, implement a `HapiBackend` with the same
surface that `fetch()`es against a real base URL:

```yaml
# docker-compose.yml
services:
  hapi:
    image: hapiproject/hapi:latest
    ports: ["8080:8080"]
    environment:
      hapi.fhir.fhir_version: R5
      hapi.fhir.cors.allowed_origin: "*"        # required for a browser client
      hapi.fhir.subscription.resthook_enabled: "true"
```

(CORS must allow the page's origin; real rest-hook delivery to a laptop needs a
reachable webhook — WebSocket subscriptions or short polling are simpler for a
live UI.)

## Layout

```
index.html          three-panel shell (Applicant | FHIR wire | Regulator)
styles.css          all styling (no external fonts/CDNs)
js/highlight.js     tiny JSON syntax highlighter
js/codesystems.js   APIX canonical systems + CodeSystems (display lookups)
js/seed.js          Organizations, Endpoint, product, SubscriptionTopics, Subscription
js/pqi.js           PQI normalization engine (sources → spec bundle, PDF render, validate)
js/scenario.js      the ordered, presenter-paced storyline
js/store.js         in-browser FHIR store + event bus (the "server")
js/app.js           UI controller
SCRIPT.md           the timed 20-minute talk track
```

## Standards referenced

- APIX — https://build.fhir.org/ig/HL7/APIX---API-Exchange-for-Medicinal-Products/
- PQI (uv-dx-pq) — https://build.fhir.org/ig/HL7/uv-dx-pq/
- HL7 Vulcan — https://hl7vulcan.org/

*Illustrative concept demonstrator. Product, organizations, and figures are fictional.*
