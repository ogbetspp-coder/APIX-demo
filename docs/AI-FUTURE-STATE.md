# AI future-state beat — grounding & guardrails

Purpose: the demo's optional **closing beat** — *"and once the content is structured,
review can be AI-assisted, responsibly."* Anchored in FDA's own AI guidance so it is
credible to senior FDA staff and never overclaims.

## The source
**FDA Draft Guidance, January 2025 — "Considerations for the Use of Artificial
Intelligence to Support Regulatory Decision-Making for Drug and Biological Products"**
(CDER/CBER; *Draft — Not for Implementation*; nonbinding).
<https://www.fda.gov/regulatory-information/search-fda-guidance-documents/considerations-use-artificial-intelligence-support-regulatory-decision-making-drug-and-biological>

Scope (verbatim sense): AI used "to **produce information or data intended to support**
regulatory decision-making regarding **safety, effectiveness, or quality**." Crucially,
"decision making refers to regulatory determinations made by **FDA**." → **AI supports;
FDA decides.**

## The framework (use these exact terms)
A **risk-based credibility assessment framework** (7 steps):
1. Define the **Question of Interest**
2. Define the **Context of Use (COU)** for the AI model
3. Assess the **AI Model Risk** — = f(**model influence**, **decision consequence**)
4. Develop a plan to establish AI model **credibility** within the COU
5. **Execute** the plan
6. **Document** the results (and deviations)
7. Determine the **adequacy** of the AI model for the COU
   + Special consideration: **life-cycle maintenance** of credibility.

Key definitions:
- **Credibility** = trust, established through *credibility evidence*, in an AI model's
  performance **for a particular COU**.
- **Model risk** = possibility the model output leads to an incorrect decision causing an
  adverse outcome = **model influence × decision consequence**.
- **Model influence** = contribution of AI-derived evidence *relative to other evidence*.
- **Decision consequence** = significance of an adverse outcome from an incorrect decision.
- Rigor / documentation **commensurate with model risk**, tailored to the COU.

## How the demo maps to it (the closing beat)
The connective insight — **structured content is the prerequisite for trustworthy AI**:
a model can reason reliably over coded `ObservationDefinition`s and a *computable*
Established-Condition change (range → range); it cannot over a 300-page narrative PDF.
So APIX + PQI is exactly what makes a **low-model-risk, human-in-the-loop** AI COU possible.

Illustrative COU for the demo (low risk by construction):
- **Question of interest** — "Does the tested batch meet the tightened end-of-shelf-life
  Water Content Established Condition (≤ 1.5% w/w)?"
- **Context of use** — an AI assistant *pre-screens* the structured PQI spec: confirms the
  computable EC delta, machine-checks the batch against the coded acceptance criteria, and
  *drafts* an assessment note for the reviewer.
- **Model influence** — **LOW**: the criterion is a deterministic numeric check; AI triages
  and summarizes, it does not adjudicate.
- **Decision consequence** — bounded: a single Type IB quality variation, fully re-checkable.
- **→ Model risk = LOW** → light credibility evidence suffices; **the human assessor decides**;
  every AI step is logged to the same `Provenance` audit trail (21 CFR Part 11 / ALCOA).

## Guardrails — do NOT overclaim
- This is **draft, nonbinding** FDA guidance, *Not for Implementation*. Label the beat
  **"future state — illustrative."**
- FDA does **not** run AI to *decide* applications. AI **supports**; the **human/FDA decides**.
  Never show "AI approved/rejected."
- Don't claim FDA uses this demo, APIX, or FHIR for AI review. The point is *architectural
  readiness*: structured FHIR content → a credible, framework-aligned AI COU.
- Keep "model risk = low" honest: it's low **because** the COU is narrow, deterministic, and
  human-in-the-loop — say that, don't imply AI is trusted in general.
