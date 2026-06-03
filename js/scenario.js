/*
 * The two-act storyline as an ordered list of presenter-paced steps.
 * Each step declares an `effect` that js/store.js + js/app.js interpret.
 * Buttons unlock in sequence so the demo is driven live, one beat at a time.
 *
 * ACT 1 — Author the content with PQI (uv-dx-pq)
 * ACT 2 — Exchange & track via APIX (the five steps)
 */
window.APIX = window.APIX || {};

APIX.scenario = [
  /* ---- ACT 1 · PQI ------------------------------------------------------ */
  {
    key: 'pull', act: 'pqi', actor: 'applicant', phase: 'Pull',
    button: 'Author the spec',
    narration: 'SynthPharma authors a routine Type IB variation for Velexa 175 mg tablets — tightening one end-of-shelf-life limit. The source data lives in three systems with their own local codes; PQI gives it one structured home.',
    effect: { type: 'pull' }
  },
  {
    key: 'normalize', act: 'pqi', actor: 'applicant', phase: 'Harmonize',
    button: 'Harmonize terms',
    narration: 'Each local term is harmonized to the PQI controlled vocabularies (and units to UCUM) by a FHIR ConceptMap / $translate — each mapping resolves as a real call you can see in Inspect.',
    effect: { type: 'normalize' }
  },
  {
    key: 'render', act: 'pqi', actor: 'applicant', phase: 'Consolidate',
    button: 'Consolidate the spec',
    narration: 'The harmonized terms consolidate into ONE structured specification — both a human-readable eCTD 3.2.P.5.1 document and the machine-readable PQI FHIR Bundle. Toggle Document / FHIR. The Water-Content tightening is a computable ICH Q12 Established-Condition change — old range → new range on a named, coded test. This is what APIX will carry.',
    effect: { type: 'render' }
  },

  /* ---- ACT 2 · APIX ----------------------------------------------------- */
  {
    key: 'connect', act: 'apix', actor: 'applicant', phase: 'Connect',
    button: 'Connect',
    narration: 'SynthPharma registers its Organization and Endpoint and authenticates with SMART Backend Services (OAuth2). One-time, machine-to-machine setup.',
    effect: { type: 'connect' }
  },
  {
    key: 'submit', act: 'apix', actor: 'applicant', phase: 'Submit',
    button: 'Submit the variation',
    narration: 'Each document is streamed as a Binary, described by a DocumentReference (the spec TWICE — PDF and FHIR), and a Task orchestrates the variation. It lands on the Health Authority instantly — no email, no portal.',
    effect: { type: 'submit' }
  },
  {
    key: 'subscribe', act: 'apix', actor: 'applicant', phase: 'Subscribe',
    button: 'Subscribe for updates',
    narration: 'SynthPharma subscribes to Task status changes. From here, every regulator action advances the status spine and updates the activity feed automatically — no polling.',
    effect: { type: 'subscribe' }
  },
  {
    key: 'receive', act: 'apix', actor: 'regulator', phase: 'Track',
    button: 'HA: acknowledge receipt',
    narration: 'The Health Authority acknowledges receipt and assigns a procedure number. The Task moves to "received" — and the subscription pushes that change straight back to SynthPharma.',
    effect: { type: 'updateTask', status: 'received', businessStatus: 'received', addProcedureNo: true, addOutputs: ['ack'] }
  },
  {
    key: 'validate', act: 'apix', actor: 'regulator', phase: 'Track',
    button: 'HA: review the spec',
    narration: 'The reviewer can open the PDF, or validate the structured spec — acceptance criteria are machine-checked against the tested batch. Try the Good and Bad batch toggle. No re-typing from a PDF.',
    effect: { type: 'updateTask', status: 'accepted', businessStatus: 'validation-successful', addOutputs: ['validation'], flexibility: true }
  },
  {
    key: 'assess', act: 'apix', actor: 'regulator', phase: 'Track',
    button: 'HA: begin assessment',
    narration: 'Assessment begins. Task.status → in-progress, businessStatus → under-assessment. SynthPharma sees the spine advance live.',
    effect: { type: 'updateTask', status: 'in-progress', businessStatus: 'under-assessment' }
  },
  {
    key: 'approve', act: 'apix', actor: 'regulator', phase: 'Track',
    button: 'HA: reach a decision',
    narration: 'Decision time — not only a happy path. On the Health Authority pane pick one of three real APIX outcomes: Approve, Request information (a clock-stop Q&A loop), or Reject. Nothing auto-approves.',
    effect: { type: 'decision' }
  }
];

/* Phase rail for the header, grouped by act. */
APIX.acts = [
  { id: 'pqi', label: 'PQI · author content', steps: ['Pull', 'Harmonize', 'Consolidate'] },
  { id: 'apix', label: 'APIX · exchange & track', steps: ['Connect', 'Stream · Describe · Orchestrate', 'Subscribe', 'Track'] }
];
