# APIX Live — 20-Minute Talk Track

A timed, click-by-click script. **Bold** = what you click. The whole demo is one
button (**▶**) advanced at your pace; this maps each click to what to say.

> One-liner to open and close with: **"PQI says *what's* in a submission. APIX
> says *how* it travels and how you *track* it. Same rails for a PDF or for
> structured data."**

---

### 0:00 – 2:00 · The problem
- A routine spec change — tightening one shelf-life limit — is a *Type IB
  variation*. Today: pull data from several systems by hand, assemble a Word/PDF
  dossier, upload to a portal, then **email and wait**. Weeks of latency, no live
  status, content trapped in PDFs.
- "Watch the same thing as **data**, end to end, in a few minutes."

### 2:00 – 3:30 · The map
- Point at the header rail: **two acts** — *PQI: author content*, then *APIX:
  exchange & track*. Left = the applicant (SynthPharma). Right = the regulator.
  Middle = **the actual FHIR R5 on the wire** — "I'll show you the real resources."

### 3:30 – 8:30 · Act 1 — PQI authors the content
- **▶ Pull spec data from source systems.** "The spec lives in three systems, in
  three formats — LIMS, stability, the method repository. A human normally
  stitches these together."
- **▶ Normalize → PQI schema.** "We map all of it to the HL7 PQI structure: one
  `PlanDefinition`, Release vs End-of-shelf-life, each test an
  `ObservationDefinition`." Point at the **amber row** — "the *one* change in this
  variation: Water Content at shelf life, 2.0 → **1.5%**."
- **▶ Produce both formats.** Click **📄** — "the human eCTD 3.2.P.5.1 — the PDF a
  reviewer reads today." Close it, click **{ }** — "the *same* content as a
  machine-readable PQI Bundle. One source of truth, two outputs." *(This sets up
  the APIX flexibility punchline.)*

### 8:30 – 15:30 · Act 2 — APIX exchanges & tracks it
- **▶ Connect.** "APIX Step 1 — register `Organization` + `Endpoint`, get a SMART
  Backend Services token." Point to the wire: real OAuth + a real `Organization`.
- **▶ Submit variation.** *Let the wire stream.* "Steps 2–4: every file streamed
  as a `Binary`, each described by a `DocumentReference`, all orchestrated by one
  `Task`." In the payload, point at the **two spec rows** — `application/pdf`
  **and** `application/fhir+json`. **This is the flexibility message: APIX is
  payload-agnostic — PDF and structured FHIR on the same rails.** Note it landed
  on the regulator **instantly** — no email.
- **▶ Subscribe.** "Step 5 — subscribe to Task status changes. From here it's
  push, not polling."
- **▶ Regulator: acknowledge receipt.** Watch the **🔔 notification** arrive and
  the **tracking timeline** light up "Received." "That's the FedEx moment — the
  applicant didn't refresh anything."
- **▶ Regulator: validate submission.** Click **✓ Validate structured spec** —
  "because the spec is structured, acceptance criteria are machine-checked against
  the batch data. No transcription from a PDF." (Or click **📄 Open PDF** to show
  the reviewer *can* still read it — same submission, reviewer's choice.)
- **▶ Begin assessment** → **▶ Approve the variation.** Watch status →
  `in-progress` → `completed`, businessStatus → **Approved**, the timeline
  complete, approval letter + assessment report attached as outputs.

### 15:30 – 18:00 · The payoff
- "Every status change was **timestamped** — that audit trail *is* your
  cycle-time analytics: benchmark phases, find bottlenecks, prove SLA."
- "Two messages: **APIX carries any payload** — we sent a PDF and structured FHIR
  together — and **PQI makes the content computable**. Together: faster, tracked,
  machine-readable regulatory exchange."
- Credibility line: "These aren't mock JSON blobs — every resource you saw is
  valid FHIR R5; I posted them to a HAPI R5 server and it accepted them."

### 18:00 – 20:00 · Roadmap & Q&A
- Scales beyond a variation: same `Task` pattern handles full marketing
  authorizations, clinical trial applications, labeling updates, fee payments.
- Siblings in the stack: **IDMP** identifies the product, **ePI** carries
  labeling, **PQI** carries quality, **APIX** moves and tracks all of it.
- Maturity note: APIX is heading to STU ballot (Jan 2027); PQI/uv-dx-pq is early —
  this demo aligns to the published examples.

---

**If you're tight on time:** skip the **Pull** detail and the second **📄/{ }**
open; the must-keep beats are **Normalize → Submit (dual-format payload) →
Validate (PDF vs structured) → Approve (live timeline).**
