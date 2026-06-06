/*
 * UI controller — single-column "submission tracker" narrative.
 *
 * The visible surface is plain business English: one quality change, submitted
 * as data, tracked end to end. A 4-step tracker (Submit · Received & checked ·
 * Review · Decision) with ONE active step at a time, a quiet activity log, and a
 * closing payoff. The ONLY place FHIR / JSON appears is the Inspect slide-over.
 *
 * The FHIR data layer (APIX.store / APIX.client / APIX.pqi / APIX.terminology)
 * is unchanged; this file only renders it. The flow is driven through the same
 * store APIs the previous controller used:
 *   store.connect() / submit() / subscribe() / updateTask(effect)   (all async)
 *   store.bus 'task' | 'notification' | 'provenance'                 (events)
 *   APIX.client.bus 'io'                                             (API-call list)
 *
 * Inspect renderers (Task card, APIX wrapper + base64 decode, ConceptMap mapping,
 * conformance OperationOutcome, Provenance audit trail, API-call list, rendered
 * eCTD spec) and the About panel + backend toggle + AI stepper are PRESERVED from
 * the prior version, ported behind plain-language surface links.
 */
(function () {
  var store = APIX.store;

  /* ============================ STATE ==================================== */
  /* Four business steps. `active` = the one in focus. Each step records a
     completion timestamp the moment it is finished. */
  var STEPS = [
    { key: 'submit',   label: 'Submit' },
    { key: 'received', label: 'Received & checked' },
    { key: 'review',   label: 'Review' },
    { key: 'decision', label: 'Decision' }
  ];
  var active = 'submit';        // current step key, or 'done' at terminal
  var done = {};                // step key -> Date completed
  var inFlight = false;         // a handler is awaiting (guards double-clicks)

  var reached = {};             // businessStatus code -> Date (for elapsed / log timing)
  var lastNotif = null;         // most recent notification (Inspect focus)
  var ioEntries = [];           // captured { request, response } interactions
  var auditEntries = [];        // audit records (kept inside Inspect only)
  var batchKey = 'good';        // 'good' | 'bad' — regulator's tested batch
  var batchChecked = false;     // a check has been run
  var infoAsked = false;        // a question round was opened
  var decided = null;           // 'approve' | 'reject'

  function el(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function show(id) { var e = el(id); if (e) e.hidden = false; }
  function hide(id) { var e = el(id); if (e) e.hidden = true; }
  function now() { return new Date(); }
  function timeStr(d) { return d ? d.toLocaleTimeString() : ''; }
  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ====================== 4. WORKFLOW TRACKER ============================ */
  function stepState(key) {
    if (done[key]) return 'done';
    if (active === key) return 'active';
    // a step is "active-but-future" until reached; everything past `active` is future
    var ai = STEPS.findIndex(function (s) { return s.key === active; });
    var ki = STEPS.findIndex(function (s) { return s.key === key; });
    return ki < ai ? 'done' : 'future';
  }
  function renderTracker() {
    var html = STEPS.map(function (s, i) {
      var st = stepState(s.key);
      var mark = st === 'done' ? '<span class="tk-mark tk-done">✓</span>'
        : '<span class="tk-mark tk-dot"></span>';
      var ts = (st === 'done' && done[s.key]) ? '<span class="tk-time">' + esc(timeStr(done[s.key])) + '</span>' : '';
      var sep = i ? '<span class="tk-sep"></span>' : '';
      return sep + '<div class="tk-step tk-' + st + '">' + mark +
        '<span class="tk-lbl">' + esc(s.label) + '</span>' + ts + '</div>';
    }).join('');
    el('tracker').innerHTML = html;
  }

  /* ====================== 5. CURRENT-STEP FOCUS ========================== */
  /* The one big active area. Plain words: whose move, a one-line description,
     and the controls for the live step. Only one renders at a time. */
  function renderFocus() {
    if (inFlight) {
      el('focus').innerHTML = focusShell('', 'Working…', '<p class="focus-desc">One moment.</p>');
      return;
    }
    switch (active) {
      case 'submit':   return renderSubmitFocus();
      case 'received': return renderReceivedFocus();
      case 'review':   return renderReviewFocus();
      case 'decision': return renderDecisionFocus();
      case 'done':     el('focus').innerHTML = ''; el('focus').hidden = true; return;
    }
  }
  function focusShell(actor, title, body) {
    var who = actor ? '<div class="focus-actor">' + esc(actor) + '</div>' : '';
    return who + '<h3 class="focus-title">' + esc(title) + '</h3>' + body;
  }

  function renderSubmitFocus() {
    el('focus').hidden = false;
    el('focus').innerHTML = focusShell('SynthPharma',
      'Ready to submit',
      '<p class="focus-desc">Send the variation to the Health Authority over the live connection.</p>' +
      '<div class="focus-controls">' +
        '<button class="btn-primary" data-act="submit">Submit to Health Authority</button>' +
      '</div>');
  }

  function renderReceivedFocus() {
    el('focus').hidden = false;
    el('focus').innerHTML = focusShell('Health Authority',
      'Received and checked',
      '<p class="focus-desc">Arrived instantly and passed automatic checks — no human action needed.</p>' +
      '<p class="focus-auto">Format and completeness OK.</p>');
  }

  function renderReviewFocus() {
    el('focus').hidden = false;
    var resultHtml = batchChecked ? batchResultHtml() : '';
    var continueBtn = batchChecked
      ? '<button class="btn-primary" data-act="to-decision">Continue to decision</button>'
      : '';
    el('focus').innerHTML = focusShell('Health Authority',
      'Review',
      '<p class="focus-desc">Check a manufactured batch against the new limit.</p>' +
      '<div class="batch-pick">' +
        '<button class="pick-opt' + (batchKey === 'good' ? ' on' : '') + '" data-batch="good">Representative batch</button>' +
        '<button class="pick-opt' + (batchKey === 'bad' ? ' on' : '') + '" data-batch="bad">Out-of-spec batch</button>' +
        '<button class="btn-ghost" data-act="run-check">Run check</button>' +
      '</div>' +
      '<div class="batch-result" id="batch-result">' + resultHtml + '</div>' +
      '<div class="focus-controls">' + continueBtn + '</div>');
  }

  /* The batch check result, in plain language. Green PASS / red FAIL — the one
     place those two colors are used. Detail (the structured criteria) is inside
     Inspect via "see the criteria". */
  function batchResultHtml() {
    var results = APIX.pqi.validate(batchKey);
    var anyFail = results.some(function (v) { return !v.pass; });
    if (anyFail) {
      return '<div class="result result-fail">' +
        '<span class="result-mark">✗</span>' +
        '<span class="result-text">Exceeds the new limit — caught automatically</span></div>' +
        '<button class="link-btn" data-inspect="batch">see the criteria</button>';
    }
    return '<div class="result result-pass">' +
      '<span class="result-mark">✓</span>' +
      '<span class="result-text">Meets the new limit (≤ 1.5%)</span></div>' +
      '<button class="link-btn" data-inspect="batch">see the criteria</button>';
  }

  function renderDecisionFocus() {
    el('focus').hidden = false;
    var convo = infoAsked ? rsiHtml() : '';
    el('focus').innerHTML = focusShell('Health Authority',
      'Decision',
      '<p class="focus-desc">Approve, ask a question, or reject.</p>' +
      '<div class="decision-row">' +
        '<button class="btn-primary" data-decision="approve">Approve</button>' +
        '<button class="btn-ghost" data-decision="info"' + (infoAsked ? ' disabled' : '') + '>Ask a question</button>' +
        '<button class="btn-ghost" data-decision="reject">Reject</button>' +
      '</div>' +
      '<div class="rsi" id="rsi">' + convo + '</div>');
  }

  /* The two-message question exchange (real text from the engine). No FHIR words
     on the surface. */
  function rsiHtml() {
    var answered = !!done.answered;
    var q = '<div class="msg msg-ha">' +
      '<div class="msg-from">Health Authority</div>' +
      '<div class="msg-body">' + esc(APIX.RSI.question) + '</div></div>';
    var a = answered
      ? '<div class="msg msg-sponsor">' +
          '<div class="msg-from">SynthPharma</div>' +
          '<div class="msg-body">' + esc(APIX.RSI.answer) + '</div></div>'
      : '<div class="focus-controls"><button class="btn-ghost" data-act="answer">Send sponsor answer</button></div>';
    return q + a;
  }

  /* ========================== 6. ACTIVITY LOG =========================== */
  /* Quiet vertical list, newest at the bottom. Plain language only; each row may
     carry a small "details" link into Inspect. */
  function logEvent(text, inspectKey) {
    var row = document.createElement('div');
    row.className = 'log-row';
    row.innerHTML = '<span class="log-time">' + timeStr(now()) + '</span>' +
      '<span class="log-msg">' + esc(text) + '</span>' +
      (inspectKey ? '<button class="link-btn" data-inspect="' + esc(inspectKey) + '">details</button>' : '');
    el('log').appendChild(row);
    el('log').scrollTop = el('log').scrollHeight;
  }

  /* ============================ DISPATCH ================================ */
  function refresh() { renderTracker(); renderFocus(); }

  /* A surface button was clicked. */
  async function runAct(actKey) {
    if (inFlight) return;
    if (actKey === 'submit')        return doSubmit();
    if (actKey === 'run-check')     return doRunCheck();
    if (actKey === 'to-decision')   return doToDecision();
    if (actKey === 'answer')        return doAnswer();
  }

  function setBatch(key) {
    if (inFlight) return;
    batchKey = key;
    el('batch-result') && (function () {
      // re-render just the pick highlight + result if already checked
    })();
    if (batchChecked) batchChecked = true; // keep prior result until re-run? No — clear it.
    batchChecked = false;
    renderFocus();
  }

  /* --- Submit (SynthPharma): real submit + the automatic received/checked chain
     with brief delays so the tracker advances live. --- */
  async function doSubmit() {
    inFlight = true; refresh();
    try {
      // Author the structured content (silent — fires the real $translate calls
      // that show up in Inspect's API list), then submit.
      APIX.terminology.rows().forEach(function (r, n) {
        setTimeout(function () { APIX.client.translate(r.source.system, r.source.code); }, 40 * n);
      });
      APIX.pqi.normalize();

      await store.connect();
      await store.submit();
      if (!reached['submitted']) reached['submitted'] = now();
      logEvent('Submitted to Health Authority', 'task');
      done.submit = now();

      await store.subscribe();

      // --- automatic chain: received, then validated ---
      active = 'received';
      inFlight = false; refresh();
      await delay(620);

      await store.updateTask({ type: 'updateTask', status: 'received', businessStatus: 'received', addProcedureNo: true, addOutputs: ['ack'] });
      await delay(560);
      await store.updateTask({ type: 'updateTask', status: 'accepted', businessStatus: 'validation-successful', addOutputs: ['validation'], flexibility: true });
      logEvent('Received and checked automatically — format and completeness OK', 'conformance');
      done.received = now();

      await delay(520);
      active = 'review';
      refresh();
    } catch (e) {
      logEvent('Submission could not be completed.');
      inFlight = false;
      refresh();
    }
  }

  /* --- Review (Health Authority): run the batch check. --- */
  async function doRunCheck() {
    inFlight = true; refresh();
    try {
      await store.updateTask({ type: 'updateTask', status: 'in-progress', businessStatus: 'under-assessment' });
      logEvent('Under review', 'task');
    } catch (e) { /* keep going — the check itself is local */ }
    batchChecked = true;
    inFlight = false;
    renderFocus();
  }

  function doToDecision() {
    active = 'decision';
    done.review = now();
    refresh();
  }

  /* --- Decision (Health Authority). --- */
  async function onDecision(kind) {
    if (inFlight || active !== 'decision') return;
    if (kind === 'info' && infoAsked) return;
    inFlight = true; refresh();
    try {
      if (kind === 'approve') {
        await store.updateTask({ type: 'updateTask', status: 'completed', businessStatus: 'approved', taskCode: 'approval', addOutputs: ['approval', 'assessment'] });
        decided = 'approve';
        logEvent('Approved', 'task');
        finish();
      } else if (kind === 'reject') {
        await store.updateTask({ type: 'updateTask', status: 'completed', businessStatus: 'rejected', taskCode: 'rejection', addOutputs: ['rejection'], statusReason: 'The tested batch did not meet the new limit.' });
        decided = 'reject';
        logEvent('Rejected', 'task');
        finish();
      } else if (kind === 'info') {
        await store.updateTask({ type: 'updateTask', status: 'on-hold', businessStatus: 'clock-stop', taskCode: 'information-request' });
        infoAsked = true;
        logEvent('Question sent', 'notif');
        inFlight = false;
        renderFocus();
        return;
      }
    } catch (e) {
      logEvent('Action could not be completed.');
    }
    inFlight = false;
    refresh();
  }

  async function doAnswer() {
    if (inFlight) return;
    inFlight = true; refresh();
    try {
      await store.updateTask({ type: 'updateTask', status: 'in-progress', businessStatus: 'clock-restart', taskCode: 'response-to-questions' });
      done.answered = now();
      logEvent('Question answered', 'notif');
    } catch (e) { logEvent('Answer could not be sent.'); }
    inFlight = false;
    renderFocus();
  }

  /* ============================ 7. PAYOFF =============================== */
  function finish() {
    done.decision = now();
    active = 'done';
    setTimeout(renderPayoff, 650);
  }

  function fmtElapsed(ms) {
    if (ms == null) return '—';
    if (ms < 1000) return ms + ' ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + ' s';
    return (ms / 60000).toFixed(1) + ' min';
  }

  function renderPayoff() {
    refresh();
    var first = reached['submitted'];
    var last = reached['approved'] || reached['rejected'] || done.decision;
    var elapsed = (first && last) ? fmtElapsed(last - first) : '—';
    var verb = decided === 'reject' ? 'Decision' : 'Decision';
    var p = el('payoff');
    p.hidden = false;
    p.innerHTML =
      '<h3 class="payoff-head">' + esc(verb) + ' in ' + esc(elapsed) + ', end to end — every step time-stamped and audited.' +
        ' <button class="link-btn" data-inspect="audit">audit trail</button></h3>' +
      '<p class="payoff-contrast">The paper equivalent: weeks of assembled documents, manual review, and status by letter.</p>' +
      '<button class="btn-ghost" id="future-toggle">Future state · AI-assisted review →</button>';
    p.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /* Closing beat (opt-in): AI-assisted review stepper. Framed strictly inside
     FDA's Jan-2025 draft framework — illustrative, low-risk, human-in-the-loop.
     The only on-surface technical hint is allowed inside this future-state note. */
  var AI_FLOW = [
    { who: 'AI',    title: 'Read',      desc: 'Read the structured submission and spot the change.' },
    { who: 'AI',    title: 'Check',     desc: 'Check the batch against the coded acceptance limit.' },
    { who: 'AI',    title: 'Draft',     desc: 'Draft the assessment note and risk flag.' },
    { who: 'AI',    title: 'Recommend', desc: 'Hand to the assessor with a recommendation.' },
    { who: 'Human', title: 'Decide',    desc: 'Assessor approves, asks, or rejects.' }
  ];
  function renderFuture() {
    var steps = AI_FLOW.map(function (s, i) {
      var arrow = i ? '<div class="ai-arrow">→</div>' : '';
      return arrow + '<div class="ai-step ai-' + (s.who === 'Human' ? 'human' : 'bot') + '">' +
        '<div class="ai-actor">' + esc(s.who) + '</div>' +
        '<div class="ai-title">' + esc(s.title) + '</div>' +
        '<div class="ai-desc">' + esc(s.desc) + '</div></div>';
    }).join('');
    el('future').innerHTML =
      '<div class="future-head"><h3>Future state — AI-assisted review</h3>' +
        '<span class="future-badge">illustrative</span></div>' +
      '<div class="ai-flow">' + steps + '</div>' +
      '<p class="future-foot">A narrow, low-risk use, human-in-the-loop — AI <strong>supports</strong>, ' +
        'FDA <strong>decides</strong>; every step audited. Possible only because the content is ' +
        '<strong>structured</strong>.</p>';
    el('future').hidden = false;
    var tg = el('future-toggle'); if (tg) tg.disabled = true;
    el('future').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /* ===================================================================== */
  /* ============================ INSPECT ================================= */
  /* The ONLY place FHIR / JSON appears. All renderers below are ported from the
     prior controller and keep full R5 fidelity. */
  function openInspect() { el('inspect').hidden = false; el('inspect-toggle').setAttribute('aria-expanded', 'true'); el('inspect-toggle').classList.add('on'); }
  function closeInspect() { el('inspect').hidden = true; el('inspect-toggle').setAttribute('aria-expanded', 'false'); el('inspect-toggle').classList.remove('on'); }
  function toggleInspect() { if (el('inspect').hidden) openInspect(); else closeInspect(); }

  function bytes(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.round(n / 1e3) + ' KB'; }

  function inspectFocus(title, htmlOrObj, isHtml) {
    var body = isHtml ? htmlOrObj : '<pre class="modal-json">' + APIX.highlight(htmlOrObj) + '</pre>';
    el('inspect-focus').innerHTML = '<div class="if-title">' + esc(title) + '</div>' + body;
  }

  /* Source-origin colors for the ConceptMap mapping table. */
  var SOURCES = [
    { key: 'lims', cls: 'org-lims', label: 'LIMS' },
    { key: 'stab', cls: 'org-stab', label: 'Stability System' },
    { key: 'meth', cls: 'org-meth', label: 'Method Repository' }
  ];
  var TERM_SOURCE = {
    'DESCR': 'lims', 'ID-HPLC': 'lims', 'POT': 'lims', 'DISSO': 'lims',
    'DEGR': 'stab', 'KF': 'stab', 'MICRO': 'lims', 'PCT_WW': 'meth', 'PCT_LC': 'meth'
  };
  function srcOf(code) { return TERM_SOURCE[code] || 'lims'; }
  function srcCls(key) { for (var i = 0; i < SOURCES.length; i++) if (SOURCES[i].key === key) return SOURCES[i].cls; return 'org-lims'; }

  function renderHarmonizeFocus() {
    var body = APIX.terminology.rows().map(function (r) {
      var skey = srcOf(r.source.code), scls = srcCls(skey);
      var slabel = (function () { for (var i = 0; i < SOURCES.length; i++) if (SOURCES[i].key === skey) return SOURCES[i].label; return 'LIMS'; })();
      return '<tr class="map-row in ' + scls + '">' +
        '<td class="m-local"><span class="m-src-tag"><span class="src-dot ' + scls + '"></span>' + esc(slabel) + '</span>' +
          '<span class="m-disp">' + esc(r.source.display) + '</span> <code>' + esc(r.source.code) + '</code></td>' +
        '<td class="m-arrow">→</td>' +
        '<td><span class="m-disp m-tgt">' + esc(r.target.display) + '</span> <code>' + esc(r.target.code) + '</code></td></tr>';
    }).join('');
    el('inspect-focus').innerHTML = '<div class="if-title">ConceptMap · $translate — local code → PQI standard term</div>' +
      '<table class="grid map-table"><thead><tr><th>Source · local code</th><th class="map-arrow-th"></th><th>PQI standard term</th></tr></thead>' +
      '<tbody>' + body + '</tbody></table>';
  }

  var BIZ_GLOSS = {
    'submitted': 'Submitted — the variation has been lodged and is awaiting acknowledgement.',
    'received': 'Received — the authority has acknowledged receipt of the submission.',
    'validation-successful': 'Administratively validated — complete and correctly classified; eligible for assessment.',
    'under-assessment': 'Under assessment — an assessor is reviewing the structured specification.',
    'clock-stop': 'On hold — Clock stop: review paused awaiting the applicant’s response to the List of Questions.',
    'clock-restart': 'Clock restart — the applicant has responded; assessment resumes.',
    'approved': 'Approved — the variation has been accepted; the specification change takes effect.',
    'rejected': 'Rejected — the variation was not accepted (see the grounds on the decision letter).'
  };

  function taskDocsList(items, fallbackIc) {
    if (!items || !items.length) return '<span class="tk-none">none yet</span>';
    return '<ul class="tk-docs">' + items.map(function (it) {
      var d = it.valueReference && it.valueReference.reference ? store.get(it.valueReference.reference) : null;
      var ct = d && d.content ? d.content[0].attachment.contentType : null;
      var ic = ct === 'application/fhir+json' ? 'FHIR' : (ct === 'application/pdf' ? 'PDF' : (fallbackIc || 'DOC'));
      var ttype = (it.type && it.type.coding && it.type.coding[0]) ? it.type.coding[0].code : '';
      return '<li><span class="doc-ic">' + esc(ic) + '</span> ' + esc(it.valueReference.display || '(document)') +
        (ttype ? ' <code>' + esc(ttype) + '</code>' : '') + '</li>';
    }).join('') + '</ul>';
  }
  function renderTaskFocus() {
    var t = store.task;
    if (!t) { inspectFocus('Task', { resourceType: 'Task' }); return; }
    var bizCode = (t.businessStatus && t.businessStatus.coding && t.businessStatus.coding[0]) ? t.businessStatus.coding[0].code : '';
    var bizDisp = (t.businessStatus && t.businessStatus.coding && t.businessStatus.coding[0]) ? t.businessStatus.coding[0].display : bizCode;
    var codeDisp = (t.code && t.code.coding && t.code.coding[0]) ? t.code.coding[0].display : '';
    var procNo = '';
    (t.identifier || []).forEach(function (id) {
      if (id.type && id.type.coding && id.type.coding[0] && id.type.coding[0].code === 'apixregulatorprocedureno') procNo = id.value;
    });
    var groupId = (t.groupIdentifier && t.groupIdentifier.value) || '';
    var requester = (t.requester && (t.requester.display || t.requester.reference)) || '—';
    var performer = (t.owner && (t.owner.display || t.owner.reference)) || '—';
    var gloss = BIZ_GLOSS[bizCode] || '';
    var reason = (t.statusReason && t.statusReason.text) || '';
    var card =
      '<div class="tk-card">' +
        '<div class="tk-row tk-head"><span class="tk-k">Submission</span>' +
          '<span class="tk-v"><strong>' + esc(codeDisp || 'Variation') + '</strong></span></div>' +
        '<div class="tk-row"><span class="tk-k">Status</span>' +
          '<span class="tk-v"><span class="badge badge-status">' + esc(t.status) + '</span>' +
          ' <span class="badge badge-biz">' + esc(bizDisp) + '</span></span></div>' +
        (gloss ? '<div class="tk-gloss">' + esc(gloss) + '</div>' : '') +
        (reason ? '<div class="tk-gloss tk-reason"><strong>Grounds:</strong> ' + esc(reason) + '</div>' : '') +
        '<div class="tk-row"><span class="tk-k">Procedure number</span><span class="tk-v"><code>' + esc(procNo || 'not yet assigned') + '</code></span></div>' +
        '<div class="tk-row"><span class="tk-k">Procedure thread</span><span class="tk-v"><code>' + esc(groupId || '—') + '</code> <small>(group identifier)</small></span></div>' +
        '<div class="tk-row"><span class="tk-k">Requester</span><span class="tk-v">' + esc(requester) + ' <small>(applicant)</small></span></div>' +
        '<div class="tk-row"><span class="tk-k">Performer</span><span class="tk-v">' + esc(performer) + ' <small>(regulator)</small></span></div>' +
        '<div class="tk-row tk-block"><span class="tk-k">Input documents</span><span class="tk-v">' + taskDocsList(t.input) + '</span></div>' +
        '<div class="tk-row tk-block"><span class="tk-k">Output documents</span><span class="tk-v">' + taskDocsList(t.output, 'PDF') + '</span></div>' +
      '</div>' +
      '<button class="link-btn tk-raw-toggle" id="tk-raw-toggle">Show raw FHIR JSON</button>' +
      '<pre class="modal-json tk-raw" id="tk-raw" hidden>' + APIX.highlight(t) + '</pre>';
    el('inspect-focus').innerHTML = '<div class="if-title">Task — Type IB variation</div>' + card;
  }

  /* APIX wrapper view — Task ▸ DocumentReference ▸ Binary (base64, real decode)
     ▸ PQI Bundle. */
  function renderWrapperFocus() {
    var t = store.task;
    var docref = store.get('DocumentReference/docref-spec-fhir');
    var bin = store.get('Binary/binary-spec-fhir');
    var bizDisp = (t && t.businessStatus && t.businessStatus.coding && t.businessStatus.coding[0]) ? t.businessStatus.coding[0].display : '—';
    var codeDisp = (t && t.code && t.code.coding && t.code.coding[0]) ? t.code.coding[0].display : 'Type IB Variation';
    var att = docref && docref.content ? docref.content[0].attachment : {};
    var b64 = (bin && bin.data) || '';
    var b64short = b64.length > 88 ? b64.slice(0, 88) + '…' : b64;
    var html =
      '<div class="wrap-stack">' +
        '<div class="wrap-layer wl-task">' +
          '<div class="wl-head"><span class="wl-tag">Task</span> envelope / orchestrator</div>' +
          '<div class="wl-meta">' +
            '<span><code>code</code> ' + esc(codeDisp) + '</span>' +
            '<span><code>status</code> ' + esc(t ? t.status : '—') + ' · <code>businessStatus</code> ' + esc(bizDisp) + '</span>' +
            '<span><code>requester</code> SynthPharma AG → <code>owner</code> Health Authority</span>' +
          '</div>' +
          '<div class="wl-arrow">input[].valueReference →</div>' +
          '<div class="wrap-layer wl-docref">' +
            '<div class="wl-head"><span class="wl-tag">DocumentReference</span> the library card</div>' +
            '<div class="wl-meta">' +
              '<span><code>type</code> 3.2.P.5.1 · ' + esc((docref && docref.type && docref.type.coding[0].display) || 'Drug Product Specification') + '</span>' +
              '<span><code>title</code> ' + esc(att.title || '—') + '</span>' +
              '<span><code>version</code> ' + esc((docref && docref.version) || '—') + ' · <code>contentType</code> ' + esc(att.contentType || '—') + '</span>' +
            '</div>' +
            '<div class="wl-arrow">content.attachment.url →</div>' +
            '<div class="wrap-layer wl-binary">' +
              '<div class="wl-head"><span class="wl-tag">Binary</span> ' + esc((bin && bin.contentType) || 'application/fhir+json') + ', base64</div>' +
              '<div class="wl-b64" id="wl-b64"><code>' + esc(b64short) + '</code></div>' +
              '<button class="link-btn wl-decode" id="wl-decode">Decode base64 →</button>' +
              '<div class="wrap-layer wl-bundle" id="wl-bundle" hidden>' +
                '<div class="wl-head"><span class="wl-tag">PQI Bundle</span> PlanDefinition + ObservationDefinitions</div>' +
                '<pre class="modal-json wl-bundle-json" id="wl-bundle-json"></pre>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';
    el('inspect-focus').innerHTML = '<div class="if-title">Payload / APIX wrapper</div>' +
      '<p class="wrap-intro">The PQI Bundle is encoded into a <code>Binary</code>, described by a <code>DocumentReference</code>, carried by a <code>Task</code>.</p>' + html;
  }

  function decodeWrapperBinary() {
    var bin = store.get('Binary/binary-spec-fhir');
    var bundleEl = el('wl-bundle'), jsonEl = el('wl-bundle-json'), btn = el('wl-decode');
    if (!bin || !bin.data || !bundleEl || !jsonEl) return;
    var decode = (typeof atob === 'function') ? atob : function (s) { return Buffer.from(s, 'base64').toString('binary'); };
    var json;
    try { json = JSON.parse(decodeURIComponent(escape(decode(bin.data)))); }
    catch (e) { try { json = JSON.parse(decode(bin.data)); } catch (e2) { json = { error: 'decode failed' }; } }
    jsonEl.innerHTML = APIX.highlight(json);
    bundleEl.hidden = false;
    if (btn) { btn.textContent = 'Decoded — equals the PQI Bundle'; btn.disabled = true; btn.classList.add('wl-decoded'); }
  }

  /* The structured acceptance-criteria check (FHIR detail) for the surface result. */
  function renderBatchFocus() {
    var results = APIX.pqi.validate(batchKey);
    var anyFail = results.some(function (v) { return !v.pass; });
    var batchLabel = (APIX.pqi.batches[batchKey] || {}).label || batchKey;
    var rows = results.map(function (v) {
      return '<tr' + (v.pass ? '' : ' class="val-fail-row"') + '><td>' + esc(v.test) + '</td><td>' + esc(v.criterion) +
        '</td><td>' + esc(v.measured) + '</td><td class="' + (v.pass ? 'pass' : 'fail') + '">' +
        (v.pass ? 'PASS' : 'FAIL') + '</td></tr>';
    }).join('');
    var banner = anyFail
      ? '<div class="val-banner val-banner-fail">OUT OF SPECIFICATION</div>'
      : '<div class="val-banner val-banner-pass">All criteria met</div>';
    el('inspect-focus').innerHTML =
      '<div class="if-title">Acceptance criteria — batch vs. structured ObservationDefinitions</div>' +
      '<div class="val-sub">' + esc(batchLabel) + '</div>' + banner +
      '<table class="val-table"><thead><tr><th>Test</th><th>Criterion</th><th>Measured</th><th>Result</th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table>';
  }

  function inspectKey(key) {
    if (key === 'task') renderTaskFocus();
    else if (key === 'harmonize') renderHarmonizeFocus();
    else if (key === 'wrapper') renderWrapperFocus();
    else if (key === 'batch') renderBatchFocus();
    else if (key === 'spec') inspectFocus('Rendered eCTD 3.2.P.5.1 (specification)', APIX.pqi.renderSpecHtml(), true);
    else if (key === 'audit') { scrollAudit(); }
    else if (key === 'conformance') inspectFocus('Conformance check — $validate OperationOutcome (automatic)', store.conformance || { resourceType: 'OperationOutcome', issue: [] });
    else if (key === 'notif') inspectFocus('Subscription notification Bundle', lastNotif || { resourceType: 'Bundle', type: 'subscription-notification' });
    else if (key === 'fhir') inspectFocus('PQI FHIR Bundle', APIX.pqi.bundle || APIX.pqi.normalize());
    else if (key.indexOf('prov:') === 0) {
      var pr = store.get('Provenance/' + key.slice(5));
      if (pr) inspectFocus('Provenance — audit record', pr);
    } else if (key.indexOf('ref:') === 0) {
      var ref = key.slice(4);
      if (ref === 'DocumentReference/docref-spec-fhir') renderWrapperFocus();
      else { var r = store.get(ref); if (r) inspectFocus(r.resourceType + (r.content ? ' — ' + r.content[0].attachment.title : ''), r); }
    }
    openInspect();
  }
  function scrollAudit() {
    // ensure the audit section is visible, then scroll to it within Inspect
    setTimeout(function () { var s = el('audit-sec'); if (s && !s.hidden) s.scrollIntoView({ block: 'start' }); }, 30);
  }

  /* ---- API-call list (APIX.client 'io' events) ---- */
  function ioStatusClass(s) { return (s >= 200 && s < 300) ? 'ok' : (s >= 400 ? 'err' : 'neu'); }
  function ioHeaderRows(h) {
    if (!h) return '';
    var keep = ['Content-Type', 'Accept', 'If-Match', 'Location', 'ETag', 'Last-Modified', 'Authorization'];
    var out = [];
    Object.keys(h).forEach(function (k) {
      for (var n = 0; n < keep.length; n++) {
        if (k.toLowerCase() === keep[n].toLowerCase()) { out.push('<div class="io-h"><span>' + esc(k) + '</span>: ' + esc(String(h[k])) + '</div>'); break; }
      }
    });
    return out.join('');
  }
  function ioBody(b) {
    if (b == null) return '<div class="io-empty">(no body)</div>';
    return '<pre class="modal-json io-json">' + APIX.highlight(b) + '</pre>';
  }
  function renderIoEntry(e) {
    var st = e.response || {}, req = e.request || {};
    var cls = ioStatusClass(st.status);
    return '<div class="io-entry" data-io="' + e.id + '">' +
      '<button class="io-sum io-' + cls + '">' +
        '<span class="io-method">' + esc(req.method || '') + '</span>' +
        '<span class="io-url">' + esc(req.url || '') + '</span>' +
        '<span class="io-arrow">→</span>' +
        '<span class="io-status">' + esc(String(st.status || '')) + ' ' + esc(st.statusText || '') + '</span>' +
        '<span class="io-label">' + esc(e.label || '') + '</span>' +
      '</button>' +
      '<div class="io-detail" hidden>' +
        '<div class="io-sec">Request</div>' +
        '<div class="io-line"><span class="io-k">' + esc(req.method || '') + '</span> ' + esc(req.url || '') + '</div>' +
        ioHeaderRows(req.headers) + ioBody(req.body) +
        '<div class="io-sec">Response</div>' +
        '<div class="io-line"><span class="io-k">' + esc(String(st.status || '')) + '</span> ' + esc(st.statusText || '') + '</div>' +
        ioHeaderRows(st.headers) + ioBody(st.body) +
      '</div>' +
    '</div>';
  }
  function setIoCount() { el('io-count').textContent = ioEntries.length; }
  function addIo(detail) {
    ioEntries.push(detail);
    setIoCount();
    var wrap = document.createElement('div');
    wrap.innerHTML = renderIoEntry(detail);
    el('io-list').appendChild(wrap.firstChild);
  }

  /* ---- Audit trail (FHIR Provenance) ---- */
  function provWho(p) {
    var a = (p.agent && p.agent[0]) || {};
    var who = (a.who && (a.who.display || a.who.reference)) || '—';
    var role = (a.type && a.type.coding && a.type.coding[0] && a.type.coding[0].display) || '';
    return esc(who) + (role ? ' <span class="aud-role">' + esc(role) + '</span>' : '');
  }
  function provWhat(p) {
    var act = (p.activity && p.activity.coding && p.activity.coding[0] && p.activity.coding[0].code) || '';
    var tgt = (p.target || []).map(function (t) { return t.reference || t.display; }).filter(Boolean);
    var head = tgt[0] || '—';
    var more = tgt.length > 1 ? ' <span class="aud-more">+' + (tgt.length - 1) + '</span>' : '';
    return '<span class="aud-act">' + esc(act) + '</span> <code>' + esc(head) + '</code>' + more;
  }
  function provWhy(p) {
    return (p.activity && p.activity.text) ||
      (p.authorization && p.authorization[0] && p.authorization[0].concept && p.authorization[0].concept.text) || '';
  }
  function renderAuditEntry(p) {
    var when = p.recorded ? new Date(p.recorded).toLocaleTimeString() : '';
    return '<tr><td class="aud-when">' + esc(when) + '</td>' +
      '<td>' + provWho(p) + '</td><td>' + provWhat(p) + '</td>' +
      '<td class="aud-why">' + esc(provWhy(p)) +
        ' <button class="link-btn" data-inspect="prov:' + esc(p.id) + '">view</button></td></tr>';
  }
  function renderAudit() {
    var has = auditEntries.length > 0;
    el('audit-sec').hidden = !has;
    el('audit-note').hidden = !has;
    el('audit-wrap').hidden = !has;
    el('audit-count').textContent = auditEntries.length;
    if (!has) { el('audit-wrap').innerHTML = ''; return; }
    el('audit-wrap').innerHTML =
      '<table class="grid audit-table"><thead><tr><th>When</th><th>Who</th><th>What</th><th>Why</th></tr></thead><tbody>' +
        auditEntries.map(renderAuditEntry).join('') + '</tbody></table>';
  }
  function addAudit(p) { auditEntries.push(p); renderAudit(); }

  /* ============================ STORE EVENTS ============================ */
  store.bus.addEventListener('task', function (ev) {
    if (ev.detail.firstTime && !reached['submitted']) reached['submitted'] = now();
  });
  store.bus.addEventListener('notification', function (ev) {
    lastNotif = ev.detail.bundle;
    var code = ev.detail.businessStatus;
    setTimeout(function () { reached[code] = now(); }, 200);
  });
  store.bus.addEventListener('provenance', function (ev) { addAudit(ev.detail.provenance); });
  APIX.client.bus.addEventListener('io', function (ev) { addIo(ev.detail); });

  /* ============================ RESET ================================== */
  function resetAll() {
    active = 'submit'; done = {}; inFlight = false;
    reached = {}; lastNotif = null; ioEntries = []; auditEntries = [];
    batchKey = 'good'; batchChecked = false; infoAsked = false; decided = null;
    store.reset();
    renderAudit();
    el('log').innerHTML = '';
    el('io-list').innerHTML = '';
    el('inspect-focus').innerHTML = '';
    hide('payoff'); el('payoff').innerHTML = '';
    hide('future'); el('future').innerHTML = '';
    setIoCount();
    closeInspect();
    refresh();
  }

  /* ===================== BACKEND TOGGLE (mock/local/live) =============== */
  function isLive() { return APIX.config && APIX.config.backend === 'hapi'; }
  function isLocal() { return APIX.config && APIX.config.backend === 'local'; }
  function reflectBackend() {
    var live = isLive(), local = isLocal();
    el('backend-toggle').classList.toggle('live', live);
    el('backend-toggle').classList.toggle('local', local);
    el('backend-mock').classList.toggle('on', !live && !local);
    el('backend-live').classList.toggle('on', live);
    el('backend-local').classList.toggle('on', local);
    el('live-indicator').hidden = !live;
    el('local-base').hidden = !local;
  }
  function setBackend(backend) {
    if (!APIX.config || APIX.config.backend === backend) return;
    APIX.config.backend = backend;
    if (backend === 'local') syncLocalBase();
    reflectBackend();
    resetAll();
  }
  function syncLocalBase() {
    var f = el('local-base');
    if (f && f.value && f.value.trim()) APIX.config.localBase = f.value.trim();
  }

  /* ============================ ABOUT ================================== */
  var ABOUT_HTML =
    '<div class="if-title">About / FDA context</div>' +
    '<p class="muted">This demo separates two halves: <strong>PQI / PQ-CMC</strong> authors the structured ' +
    'pharmaceutical-quality <em>content</em>; <strong>APIX</strong> is the FHIR R5 <em>transport</em> that ' +
    'submits, tracks, and pushes updates. The thesis — structured CMC content carried by an API-first FHIR ' +
    'transport with real-time tracking — is in <strong>directional alignment with FDA\'s stated direction</strong>. ' +
    'FDA has built the content half and a structured-assessment engine; an APIX-style FHIR transport is the ' +
    'not-yet-built half.</p>' +
    '<div class="fda-honesty">Honesty line (maturity). FDA does <strong>not</strong> accept FHIR ' +
    '<em>submissions</em> in production, and FDA is <strong>not</strong> a named APIX participant (it <em>is</em> ' +
    'a named contributor to Vulcan\'s ePI profile, with EMA and PMDA). Maturity gradient: ' +
    '<strong>KASA = production</strong> (SODF) · <strong>PQ-CMC FHIR IG = STU / draft</strong> (SODF-only, ' +
    'voluntary / for-comment, not mandatory) · <strong>eCTD v4.0 two-way comms = removed from current scope</strong> · ' +
    '<strong>APIX = pre-ballot</strong> (IG v0.1.0). This demo shows the transport half in real FHIR R5 — never "FDA\'s plan."</div>' +
    '<div class="inspect-sec" style="border-top:none">Three distinct &ldquo;validations&rdquo;</div>' +
    '<p class="muted">The word &ldquo;validation&rdquo; means three different things in this exchange. ' +
    'Only the third is a human act; the first two are automatic and in-flight.</p>' +
    '<table class="val-table about-table"><thead><tr><th>Step</th><th>What it is</th></tr></thead><tbody>' +
    '<tr><td><strong>Conformance check</strong> <em>(automatic)</em></td>' +
      '<td>FHIR <code>$validate</code> &rarr; <code>OperationOutcome</code> &mdash; format/profile conformance of the payload as it is submitted.</td></tr>' +
    '<tr><td><strong>Administrative validation</strong> <em>(automatic / fast)</em></td>' +
      '<td>The authority&rsquo;s completeness + correct-classification / eligibility check &rarr; <code>validation-successful</code>.</td></tr>' +
    '<tr><td><strong>Scientific assessment</strong> <em>(human)</em></td>' +
      '<td>The assessor&rsquo;s review of the structured acceptance-criteria &rarr; <code>under-assessment</code>.</td></tr>' +
    '</tbody></table>' +
    '<div class="inspect-sec">Where this fits at FDA</div>' +
    '<table class="val-table about-table"><thead><tr><th>FDA anchor</th><th>Alignment</th></tr></thead><tbody>' +
    '<tr><td><strong>PQ-CMC FHIR IG</strong> (FDA-funded, R5, eCTD Module 3)</td>' +
      '<td>Same FHIR R5, same BR&amp;R work group, same structured-spec model as FDA\'s own IG. ' +
      'Velexa is a film-coated tablet — a <strong>Solid Oral Dosage Form, inside PQ-CMC\'s current scope</strong>.</td></tr>' +
    '<tr><td><strong>KASA</strong> (CDER/OPQ structured assessment)</td>' +
      '<td>Our structured <code>PlanDefinition</code> + <code>ObservationDefinition</code> spec is the kind of ' +
      'structured input a KASA-style assessment consumes. <em>Production (SODF).</em></td></tr>' +
    '<tr><td><strong>ICH Q12 Established Conditions</strong></td>' +
      '<td>The Water-Content variation is a <strong>computable EC change</strong> — old range &rarr; new range on a ' +
      'named, coded test. <em>Final guidance.</em></td></tr>' +
    '<tr><td><strong>ESG NextGen</strong> submit / status / acknowledge</td>' +
      '<td>APIX is the FHIR-native rendering of an ESG-NextGen-style submit-and-track API — NextGen is REST <em>poll</em> for status; APIX adds real-time push + structured workflow state. <em>Production (REST, not FHIR).</em></td></tr>' +
    '<tr><td><strong>21 CFR Part 11 / ALCOA</strong></td>' +
      '<td><code>Task</code> + <code>businessStatus</code> + versioning + <code>Provenance</code> = the ' +
      'who / what / when / why audit trail by design. <em>Regulation.</em></td></tr>' +
    '</tbody></table>' +
    '<div class="inspect-sec">Real vs Simulated</div>' +
    '<table class="val-table about-table"><thead><tr><th>Aspect</th><th>Status</th></tr></thead><tbody>' +
    '<tr><td>FHIR R5 resources (Task, DocumentReference, Binary, Subscription, Provenance, PQI Bundle)</td><td class="pass">Real &amp; conformant</td></tr>' +
    '<tr><td><strong>Live</strong> mode: POST / GET / $validate over the wire</td><td class="pass">Real, against public hapi.fhir.org/baseR5</td></tr>' +
    '<tr><td>OAuth2 / SMART Backend Services token</td><td class="sim">Simulated (labeled; orthogonal to the exchange)</td></tr>' +
    '<tr><td>Real-time push delivery</td><td class="sim">Public HAPI: UI reads the Task back. Local HAPI: real WebSocket push.</td></tr>' +
    '</tbody></table>' +
    '<p class="muted">Mock mode is the stage default: offline, deterministic, instant. ' +
    '<a href="https://build.fhir.org/ig/HL7/APIX---API-Exchange-for-Medicinal-Products/" target="_blank" rel="noopener">APIX IG ↗</a> · ' +
    '<a href="https://build.fhir.org/ig/HL7/FHIR-us-pq-cmc-fda/" target="_blank" rel="noopener">PQ-CMC FHIR IG ↗</a></p>';

  /* ============================ WIRING ================================= */
  document.addEventListener('click', function (ev) {
    var sum = ev.target.closest('.io-sum');
    if (sum) { var det = sum.parentNode.querySelector('.io-detail'); if (det) det.hidden = !det.hidden; return; }
    if (ev.target.closest('#tk-raw-toggle')) {
      var raw = el('tk-raw'), tg = el('tk-raw-toggle');
      if (raw) { raw.hidden = !raw.hidden; if (tg) tg.textContent = raw.hidden ? 'Show raw FHIR JSON' : 'Hide raw FHIR JSON'; }
      return;
    }
    if (ev.target.closest('#wl-decode')) { decodeWrapperBinary(); return; }
    if (ev.target.closest('#future-toggle')) { renderFuture(); return; }
    var ins = ev.target.closest('[data-inspect]'); if (ins) { inspectKey(ins.getAttribute('data-inspect')); return; }
    var b = ev.target.closest('[data-batch]'); if (b) { setBatch(b.getAttribute('data-batch')); return; }
    var dec = ev.target.closest('[data-decision]'); if (dec) { onDecision(dec.getAttribute('data-decision')); return; }
    var a = ev.target.closest('[data-act]'); if (a) { runAct(a.getAttribute('data-act')); return; }
  });

  el('resetbtn').addEventListener('click', resetAll);
  el('inspect-toggle').addEventListener('click', toggleInspect);
  el('inspect-close').addEventListener('click', closeInspect);
  el('view-spec').addEventListener('click', function () { inspectFocus('Specification — Velexa 175 mg (rendered)', APIX.pqi.renderSpecHtml(), true); openInspect(); });
  el('about-btn').addEventListener('click', function () { el('inspect-focus').innerHTML = ABOUT_HTML; openInspect(); });
  el('backend-mock').addEventListener('click', function () { setBackend('mock'); });
  el('backend-live').addEventListener('click', function () { setBackend('hapi'); });
  el('backend-local').addEventListener('click', function () { setBackend('local'); });
  el('local-base').addEventListener('change', function () { syncLocalBase(); if (isLocal()) resetAll(); });

  reflectBackend();
  refresh();
})();
