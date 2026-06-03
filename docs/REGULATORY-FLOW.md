# Regulatory flow — realism anchor for the demo

Purpose: make the Company⇄Regulator exchange authentic to a regulator/FDA audience,
and remove the "validation" confusion. Anchored in EU Type IB variation procedure
+ the FDA supplement analogue. Cited.

## The key fix: three different "validations" — label them distinctly
1. **Conformance check (automatic, in-flight)** — FHIR `$validate` → `OperationOutcome`
   (format/profile conformance). Happens to the payload as it is submitted. *Not a human act.*
   <https://www.hl7.org/fhir/validation.html>
2. **Administrative validation** — the authority's completeness + correct-classification/
   eligibility check (the regulatory "validation"); fast, largely mechanical → `validation-successful`.
   <https://www.ema.europa.eu/en/human-regulatory-overview/post-authorisation/classification-changes-questions-answers>
3. **Scientific assessment** — the Rapporteur/assessor's human review → `under-assessment`.
   The structured acceptance-criteria (good/bad batch) check belongs here.
   <https://www.ema.europa.eu/en/human-regulatory-overview/post-authorisation/variations-including-extensions-marketing-authorisations/type-ib-variations-questions-answers>

## Realistic ordered flow (AUTO = transport/server, no human · HUMAN = assessor/applicant)
| # | Step | Actor | Auto/Human | Task.status | businessStatus |
|---|------|-------|-----------|-------------|----------------|
| 1 | Author PQI spec, assemble payload | MAH | HUMAN | — | — |
| 2 | Submit variation Task over APIX | MAH→APIX | AUTO | requested | submitted |
| 3 | `$validate` → OperationOutcome (conformance) | server | **AUTO** | — | — |
| 4 | Acknowledgement of receipt | APIX/CA | AUTO | received | received |
| 5 | Administrative validation (completeness) | CA | AUTO/quick | accepted | validation-successful |
| 6 | Scientific assessment begins | CA | **HUMAN** | in-progress | under-assessment |
| 7 | (branch) Request for Supplementary Information | CA | **HUMAN** | on-hold | clock-stop · code information-request |
| 8 | Applicant responds | MAH | **HUMAN** | in-progress | clock-restart · code response-to-questions |
| 9 | Decision | CA | **HUMAN** | completed | approved (code approval) / rejected (code rejection + statusReason) |

Every transition is pushed to subscribers via topic-based `Subscription` → notification Bundle (AUTO).
**Stage principle:** conformance is automatic; administrative validation is fast/mechanical; **assessment, questions, and the decision are human.**

## Fidelity notes
- **Type IB has no *formal* clock-stop** (that is a **Type II** mechanism); EMA issues a single **RSI** (~day 30), response (~day 60), outcome (~day 90); no opinion in 30 days = **"deemed acceptable."** The APIX IG's own Type IB example nonetheless uses `clock-stop`, so we keep the APIX `clock-stop`/`clock-restart` businessStatus but **label the branch "Request for Supplementary Information (RSI)."**
  <https://www.hma.eu/uploads/media/240415_CMDv_BPG-005_Type_IB.pdf>
- Don't skip **`received`** — there is a distinct acknowledgement of receipt (EU) / ESG second-ack receipt date (FDA) before validation.
- **FDA analogue:** post-approval changes are **supplements** (PAS / CBE-30 / CBE-0, 21 CFR 314.70); completeness gate = the **filing decision** (314.101); review issues **Information Requests**; ends in approval or a **Complete Response Letter** (314.110).
  <https://www.ecfr.gov/current/title-21/chapter-I/subchapter-D/part-314/subpart-B/section-314.70>
- **Maturity:** the APIX `apix-business-status` CodeSystem is **draft** and APIX v0.1.0 is **pre-ballot** — say so once (already in About).

## Demo changes this implies
- Make `$validate` (conformance) + `received` + `validation-successful` **automatic on Submit** — the payload lands already conformant, received, and admin-validated; the spine auto-advances Submitted → Received → Validated.
- The Regulator's human buttons become **Assess** (reveals the acceptance-criteria check; → under-assessment) → **Decide** (Approve / Request information (RSI) / Reject). Remove the redundant manual "Validate."
- Use authoritative APIX displays (Validation Successful, Under Assessment, Clock Stop, Clock Restart, Decision Pending); add `clock-restart`.
