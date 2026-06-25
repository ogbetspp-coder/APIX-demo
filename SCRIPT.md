# APIX × PQI — 20-minute talk track (FDA-tailored)

Audience: HL7 Vulcan + **senior FDA IT**. Tone: sober, precise, standards-grade.
Every FDA claim here traces to `docs/FDA-ALIGNMENT.md`. **The credibility move is
precision about what is real vs. aspirational — say it first.**

**Before you start.** Backend = **Mock** (default; offline, instant, stage-safe).
For the live hero moment, have **Local HAPI** ready (`cd deploy/hapi-r5 && docker
compose up -d && ./seed.sh`) or use public **Live**. Open `index.html`. Mock is
the safety net — if anything wobbles live, flip back to Mock and keep going.

> **Do NOT say:** "FDA's plan", "FDA endorses APIX", "FDA accepts FHIR submissions",
> or that structured CMC is mandatory. APIX is **pre-ballot (IG v0.1.0)**; FDA is a
> named contributor to Vulcan's **ePI** profile, **not** an APIX participant.

---

### 0:00–2:30 · The problem, and the honest frame
- "A safety-driven post-approval CMC change — **adding a nitrosamine (NDSRI)
  limit** to a finished-product spec — is filed as a **US Prior Approval
  Supplement**. Today it travels as assembled PDFs through a gateway, reviewed as
  narrative. Weeks; no structured data; no live status."
- **Set expectations up front (this is what earns the room):** "To be precise about
  where FDA actually is: FDA funds the **PQ-CMC FHIR IG** (R5, solid-oral-dose,
  STU/draft, voluntary); runs **KASA** in production for structured generic-SODF
  quality assessment; and exposes **ESG NextGen** REST submit/status APIs. FDA has
  **not** adopted FHIR as a submission *transport*. So this demo shows the *transport
  half, in FHIR* — directional alignment with FDA's stated direction, **not** FDA's plan."
- Open **About / FDA context** briefly to show the maturity line is on the record.

### 2:30–7:30 · Act 1 — Author the content (PQI), as structured data
- **[Next → "Pull"]** "The spec lives across LIMS, stability, methods — three local
  vocabularies." 
- **[Next → "Harmonize"]** Watch the mapping table fill. "Each local term is
  harmonized to controlled vocabulary + UCUM via a real **FHIR ConceptMap /
  $translate** — the calls are in **Inspect**." Open **Inspect** once, show a
  `$translate`. FDA hook: "This is the same structured-content direction as FDA's
  **PQ-CMC** IG — same FHIR R5, same Module-3 quality model; and **Velexa is a
  solid-oral-dose tablet — inside PQ-CMC's current scope.**"
- **[Next → "Consolidate"]** "One structured specification." Toggle **Document ⇄
  FHIR**. "The same source is a human eCTD 3.2.P.5.1 view *and* a machine-readable
  PQI Bundle — the **same NDSRI limit** highlighted in both faces." Then the kicker:
  "That limit isn't typed in — it's **computed**: acceptable intake **100 ng/day ÷
  350 mg/day max daily dose = 0.29 ppm**. A PDF states a number; structured data
  **derives** it, and re-derives if the dose changes. A calculation a document
  physically cannot do."

### 7:30–13:00 · Act 2 — Carry it over APIX (the transport half)
- **[Next → "Connect"]** "APIX Step 1 — register `Organization` + `Endpoint`,
  authenticate (SMART Backend Services; simulated here, labeled in About)."
- **[Optional: flip Backend → Live/Local]** "Same UI, real server." 
- **[Next → "Submit"]** "Steps 2–4: the spec is streamed as a `Binary`, described by a
  `DocumentReference`, orchestrated by one `Task` — carried as **one structured
  payload** (the eCTD 3.2.P.5.1 view is a *rendering* of that same data, not a second
  file). APIX is payload-agnostic." On **Live**: click **View on public
  server** — "this `Task` is now on a FHIR server we don't control. Open it
  yourself." FDA hook: "This is the FHIR-native rendering of an **ESG-NextGen-style**
  submit-and-track API."
- **[Next → "Subscribe"]** "A topic-based `Subscription`. From here the regulator's
  actions push back. On Local HAPI this is a **real WebSocket** notification."

### 13:00–17:30 · Act 3 — Review, decide, and the FDA-grade substance
- **[Next → "Received"]** Health Authority pane fills; the **status spine** advances
  with timestamps.
- **Review — the data-over-documents proof.** The batch defaults to the
  out-of-spec one; click **Validate structured data** → the acceptance criterion
  **fails instantly, bold red** (N-nitroso-velexate **0.45 ppm** vs the computed
  **≤ 0.29 ppm**). "In a 300-page PDF that's buried; structured, it's caught at
  submit. This is the input a **KASA-style** structured assessment consumes."
- **The gasp — cryptographic integrity.** In the case detail, **Verify** the
  applicant's signature → green *signed by SynthPharma*. Tick **Tamper** → the
  signed NDSRI limit is altered → **Verify** again → red *signature invalid,
  content altered after signing*. "Real RSA-PSS over the canonical Bundle; a PDF
  has no equivalent."
- **Audit trail — for the FDA IT seniors.** Open **Inspect → Audit trail**. "Every
  transition emits a FHIR **`Provenance`** — the **who/what/when/why** FDA's
  data-integrity guidance requires. Audit-by-design, mapped to **21 CFR Part 11 /
  ALCOA**." (Valid R5; visible in the inspector.)
- **Decision — not a scripted happy path.** "Regulator chooses: **Approve**,
  **Request information** (a clock-stop Q&A round-trip — the two-way loop **eCTD
  v4.0** *plans*), or **Reject**." Do **Request information** → respond → **Approve**.

### 17:30–20:00 · Close — value, alignment, and the line that lands
- The **end Summary** appears: cycle-time from the real timestamps, minutes-vs-weeks.
  "Every transition timestamped — measurable cycle time, the value behind **RTOR**'s
  structured-review results."
- **Conformance:** "These aren't mock blobs. `./validation/validate.sh` runs the
  **official HL7 validator** against the real **APIX + PQI IGs** — clean but one
  documented upstream-IG display bug." 
- **The alignment, stated honestly:** "PQI/PQ-CMC = the structured **content** (FDA
  is already building this in FHIR). APIX = the **transport + state + real-time**
  half FDA hasn't built yet. It aligns with FDA's own posture — **TMAP/DMAP**'s
  'external data interfaces', 'industry standards', 'interoperable' — and with
  **IDMP/SPL/GSRS** product data FDA already standardizes. It complements **KASA**
  and **PQ-CMC**; it doesn't duplicate them."
- Close: "Pre-ballot, but real, conformant, and runnable today on HAPI R5. The leave-
  behind has the standards, architecture, and sources."

---

**If time is tight, the must-keep beats:** the honesty frame (0:00) · Harmonize→
Consolidate with the **computed-limit** line (AI÷MDD) · Submit + **View on public
server** · **out-of-spec FAIL** + **signature tamper** · **Audit trail /
Provenance** · the alignment close.

**If a live call wobbles:** flip Backend → **Mock** and continue; say "switching to
the offline reference server" — the resources and the story are identical.
