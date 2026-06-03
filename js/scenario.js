/*
 * The storyline as deliberate user actions. Each step declares an `effect`
 * that js/app.js interprets; some steps fan out into several under-the-hood
 * operations so the status spine advances through every node while the user
 * clicks only a few times.
 *
 * Realism anchor: docs/REGULATORY-FLOW.md. The Submit click triggers an
 * AUTOMATIC transport/server chain — no human action:
 *   $validate → OperationOutcome (conformance) · received · validation-successful.
 * The payload therefore lands on the regulator's pane already conformant,
 * received, and administratively validated. The regulator's HUMAN buttons are
 * Assess (scientific/technical content review → under-assessment) then Decide.
 *
 * 1 Author    (Industry)         — harmonize + consolidate the ONE structured spec
 * 2 Submit    (Industry → APIX)  — connect + Binary/DocumentReference/Task + subscribe,
 *                                  then the auto chain: $validate · received · validated
 * 3 Assess    (Health Authority) — reveal the acceptance-criteria teeth → under-assessment
 * 4 Decide    (Health Authority) — Approve / Request information (RSI) / Reject
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

  /* 2 — Submit: connect + stream/describe/orchestrate + subscribe (Industry),
     then the AUTOMATIC transport/server chain — $validate (conformance) →
     received → validation-successful. The payload lands on the HA pane already
     conformant, received, and administratively validated; no human action. */
  {
    key: 'submit', act: 'apix', actor: 'applicant', phase: 'Submit',
    button: 'Submit',
    effect: { type: 'submit' }
  },

  /* 3 — Assess: the regulator's HUMAN scientific/technical content review.
     Reveals the acceptance-criteria (Good/Bad batch) teeth → under-assessment. */
  {
    key: 'assess', act: 'apix', actor: 'regulator', phase: 'Assess',
    button: 'Assess',
    effect: { type: 'updateTask', status: 'in-progress', businessStatus: 'under-assessment' }
  },

  /* 4 — Decide: the decision branch — Approve / Request information (RSI) /
     Reject (Health Authority). */
  {
    key: 'decide', act: 'apix', actor: 'regulator', phase: 'Decide',
    button: 'Decide',
    effect: { type: 'decide' }
  }
];

/* Phase rail (kept for any consumer); grouped by act. */
APIX.acts = [
  { id: 'pqi', label: 'PQI · author content', steps: ['Author'] },
  { id: 'apix', label: 'APIX · exchange & track', steps: ['Submit', 'Assess', 'Decide'] }
];
