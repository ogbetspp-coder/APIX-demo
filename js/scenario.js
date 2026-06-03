/*
 * The storyline as ~4 deliberate user actions. Each step declares an `effect`
 * that js/app.js interprets; some steps fan out into several under-the-hood
 * operations so the status spine advances through every node while the user
 * clicks only four times.
 *
 * 1 Author    (Industry) — harmonize + consolidate the ONE structured spec
 * 2 Submit    (Industry) — connect + create Binary/DocumentReference/Task + subscribe
 * 3 Validate  (Health Authority) — receive (auto) → validation-successful + teeth
 * 4 Decide    (Health Authority) — assess → decision branch
 *
 * The button label is the only guidance — a concise verb. No narration.
 */
window.APIX = window.APIX || {};

APIX.scenario = [
  /* 1 — Author the ONE structured specification (Industry). */
  {
    key: 'author', act: 'pqi', actor: 'applicant', phase: 'Author',
    button: 'Author specification',
    effect: { type: 'author' }
  },

  /* 2 — Submit: connect + stream/describe/orchestrate + subscribe (Industry).
     The payload lands on the HA pane automatically (auto-"received"). */
  {
    key: 'submit', act: 'apix', actor: 'applicant', phase: 'Submit',
    button: 'Submit',
    effect: { type: 'submit' }
  },

  /* 3 — Validate the structured spec (Health Authority). */
  {
    key: 'validate', act: 'apix', actor: 'regulator', phase: 'Validate',
    button: 'Validate',
    effect: { type: 'updateTask', status: 'accepted', businessStatus: 'validation-successful', addOutputs: ['validation'], flexibility: true }
  },

  /* 4 — Decide: under-assessment, then the decision branch (Health Authority). */
  {
    key: 'decide', act: 'apix', actor: 'regulator', phase: 'Decide',
    button: 'Decide',
    effect: { type: 'decide' }
  }
];

/* Phase rail (kept for any consumer); grouped by act. */
APIX.acts = [
  { id: 'pqi', label: 'PQI · author content', steps: ['Author'] },
  { id: 'apix', label: 'APIX · exchange & track', steps: ['Submit', 'Validate', 'Decide'] }
];
