# Regulatory flow — realism anchor for the demo

Purpose: make the Applicant⇄FDA exchange authentic to a US regulatory audience,
and remove the "validation" confusion. Anchored in the **US Prior Approval
Supplement (PAS)** procedure under **21 CFR 314.70**. Cited.

## The key fix: three different "validations" — label them distinctly
1. **Conformance check (automatic, in-flight)** — FHIR `$validate` → `OperationOutcome`
   (format/profile conformance). Happens to the payload as it is submitted. *Not a human act.*
   <https://www.hl7.org/fhir/validation.html>
2. **Filing / administrative review** — FDA's completeness + correct-classification
   check (the regulatory "filing decision"); fast, largely mechanical → `validation-successful`.
   <https://www.ecfr.gov/current/title-21/section-314.101>
3. **Scientific assessment** — the FDA (OPQ/CDER) reviewer's human review → `under-assessment`.
   The structured acceptance-criteria (good/bad batch) check belongs here.
   <https://www.fda.gov/drugs/types-applications/prior-approval-supplement-information>

## Realistic ordered flow (AUTO = transport/server, no human · HUMAN = reviewer/applicant)
| # | Step | Actor | Auto/Human | Task.status | businessStatus |
|---|------|-------|-----------|-------------|----------------|
| 1 | Author PQI spec, assemble payload | Applicant | HUMAN | — | — |
| 2 | Submit PAS Task over APIX | Applicant→APIX | AUTO | requested | submitted |
| 3 | `$validate` → OperationOutcome (conformance) | server | **AUTO** | — | — |
| 4 | Acknowledgement of receipt (ESG ack) | APIX/FDA | AUTO | received | received |
| 5 | Filing decision / completeness (314.101) | FDA | AUTO/quick | accepted | validation-successful |
| 6 | Scientific assessment begins | FDA | **HUMAN** | in-progress | under-assessment |
| 7 | (branch) Information Request — review clock paused | FDA | **HUMAN** | on-hold | clock-stop · code information-request |
| 8 | Applicant responds | Applicant | **HUMAN** | in-progress | clock-restart · code response-to-questions |
| 9 | Decision | FDA | **HUMAN** | completed | approved (code approval) / rejected (code rejection + statusReason) |

Every transition is pushed to subscribers via topic-based `Subscription` → notification Bundle (AUTO).
**Stage principle:** conformance is automatic; the filing decision is fast/mechanical; **assessment, the Information Request, and the decision are human.**

## Fidelity notes
- **Why a PAS (not CBE-30 / annual report).** Establishing a new **nitrosamine
  (NDSRI) acceptance criterion + analytical method** for a safety-critical impurity
  is a change that warrants **prior approval** (21 CFR 314.70(b)) — so a genuine FDA
  **review clock** applies, which is what the real-time status spine tracks. A mere
  *tightening* of an existing limit would typically be CBE-30/annual-report and carry
  no review clock, which is exactly why the demo does **not** use that change.
  <https://www.ecfr.gov/current/title-21/chapter-I/subchapter-D/part-314/subpart-B/section-314.70>
- **Review clock / Information Requests.** During review, FDA issues **Information
  Requests**; an unresolved IR effectively pauses progress pending the applicant's
  response. The APIX `apix-business-status` CodeSystem models this as
  `clock-stop` / `clock-restart`; we keep those codes and **label the branch
  "Information Request."**
- **Don't skip `received`** — there is a distinct **acknowledgement of receipt**
  (the FDA ESG second-ack receipt date) before the filing decision.
- **Outcome.** A PAS ends in **approval** or a **Complete Response Letter** (CRL,
  21 CFR 314.110) — never a silent close.
  <https://www.ecfr.gov/current/title-21/section-314.110>
- **The computed limit.** The NDSRI limit is **derived**: acceptable intake
  (100 ng/day, CPCA Category 2) ÷ maximum daily dose (350 mg/day) = **0.29 ppm** —
  a calculation structured data does for free and a PDF cannot.
  <https://www.fda.gov/regulatory-information/search-fda-guidance-documents/recommended-acceptable-intake-limits-nitrosamine-drug-substance-related-impurities>
- **Maturity:** the APIX `apix-business-status` CodeSystem is **draft** and APIX
  v0.1.0 is **pre-ballot** — say so once (already in About).

## Demo changes this implies
- Make `$validate` (conformance) + `received` + `validation-successful` **automatic on Submit** — the payload lands already conformant, received, and filing-accepted; the spine auto-advances Submitted → Received → Filed.
- The Regulator's human buttons are **Assess** (reveals the acceptance-criteria check; → under-assessment) → **Decide** (Approve / Request information / Issue Complete Response). No redundant manual "Validate."
- Use authoritative APIX displays (Validation Successful, Under Assessment, Clock Stop, Clock Restart); add `clock-restart`.
