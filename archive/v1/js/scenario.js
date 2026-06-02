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
    button: 'Pull spec data from source systems',
    narration: 'The specification lives in three systems — LIMS, the stability system, and the method repository — in three different formats. Today, a human stitches these into a Word document.',
    effect: { type: 'pull' }
  },
  {
    key: 'normalize', act: 'pqi', actor: 'applicant', phase: 'Normalize',
    button: 'Normalize → PQI schema',
    narration: 'We map and normalize all of it to the HL7 PQI schema: one PlanDefinition with Release and End-of-shelf-life groups, each test an ObservationDefinition. Note the one change in this variation — the shelf-life Water Content limit.',
    effect: { type: 'normalize' }
  },
  {
    key: 'render', act: 'pqi', actor: 'applicant', phase: 'Render',
    button: 'Produce both formats (PDF + FHIR)',
    narration: 'From that single structured source we generate BOTH a human-readable eCTD 3.2.P.5.1 PDF and the machine-readable PQI FHIR Bundle. Same content, two formats.',
    effect: { type: 'render' }
  },

  /* ---- ACT 2 · APIX ----------------------------------------------------- */
  {
    key: 'connect', act: 'apix', actor: 'applicant', phase: 'Connect',
    button: '1 · Connect (Organization + Endpoint)',
    narration: 'APIX Step 1: SynthPharma registers its Organization and Endpoint and authenticates with SMART Backend Services (OAuth2). One-time setup, machine-to-machine.',
    effect: { type: 'connect' }
  },
  {
    key: 'submit', act: 'apix', actor: 'applicant', phase: 'Stream · Describe · Orchestrate',
    button: '2–4 · Submit variation (Binary → DocumentReference → Task)',
    narration: 'Steps 2–4 in one go: each document is streamed as a Binary, described by a DocumentReference (incl. the spec TWICE — as PDF and as FHIR), and a Task is created to orchestrate the variation. It lands on the regulator instantly — no email, no portal.',
    effect: { type: 'submit' }
  },
  {
    key: 'subscribe', act: 'apix', actor: 'applicant', phase: 'Subscribe',
    button: '5 · Subscribe for real-time updates',
    narration: 'APIX Step 5: SynthPharma subscribes to Task status changes. From here, every regulator action pushes a notification back automatically.',
    effect: { type: 'subscribe' }
  },
  {
    key: 'receive', act: 'apix', actor: 'regulator', phase: 'Track',
    button: 'Regulator: acknowledge receipt',
    narration: 'The Health Authority acknowledges receipt and assigns a procedure number. The Task moves to "received" — and the subscription fires a real-time notification back to SynthPharma.',
    effect: { type: 'updateTask', status: 'received', businessStatus: 'received', addProcedureNo: true, addOutputs: ['ack'] }
  },
  {
    key: 'validate', act: 'apix', actor: 'regulator', phase: 'Track',
    button: 'Regulator: validate submission',
    narration: 'Here is the flexibility payoff: the reviewer can OPEN the PDF, or CHECK the structured spec — the acceptance criteria are machine-validated against the batch data. No re-typing from a PDF.',
    effect: { type: 'updateTask', status: 'accepted', businessStatus: 'validation-successful', addOutputs: ['validation'], flexibility: true }
  },
  {
    key: 'assess', act: 'apix', actor: 'regulator', phase: 'Track',
    button: 'Regulator: begin assessment',
    narration: 'Assessment clock starts. Task.status → in-progress, businessStatus → under-assessment. SynthPharma sees it change live.',
    effect: { type: 'updateTask', status: 'in-progress', businessStatus: 'under-assessment' }
  },
  {
    key: 'approve', act: 'apix', actor: 'regulator', phase: 'Track',
    button: 'Regulator: approve the variation',
    narration: 'Positive decision: Task.status → completed, businessStatus → approved, with the approval letter and assessment report attached. Every transition was timestamped — that is your cycle-time analytics.',
    effect: { type: 'updateTask', status: 'completed', businessStatus: 'approved', addOutputs: ['approval', 'assessment'] }
  }
];

/* Phase rail for the header, grouped by act. */
APIX.acts = [
  { id: 'pqi', label: 'PQI · author content', steps: ['Pull', 'Normalize', 'Render'] },
  { id: 'apix', label: 'APIX · exchange & track', steps: ['Connect', 'Stream · Describe · Orchestrate', 'Subscribe', 'Track'] }
];
