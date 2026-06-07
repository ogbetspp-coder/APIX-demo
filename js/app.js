/*
 * UI controller — a guided 3-beat story for a lay audience (and FDA technical
 * viewers). One idea per screen:
 *
 *   1 · The change       SynthPharma tightens a quality limit. A Document↔Data
 *                         toggle makes the structured-data idea obvious.
 *   2 · Send & check      The real APIX submit chain runs; FDA's system reads the
 *                         data and machine-checks a real batch (data vs data).
 *   3 · Decision + AI      FDA decides; an AI assessment streams, generated live
 *                         from the real batch values.
 *
 * Plain English on the surface. The FHIR R5 engine (APIX.store / client / pqi /
 * terminology) is UNCHANGED — this file only renders it and drives the flow:
 *   store.connect() / submit() / subscribe() / updateTask(effect)   (all async)
 *   store.bus 'task' | 'notification' | 'provenance'                 (events)
 *   APIX.client.bus 'io'                                             (API-call list)
 *
 * The Inspect slide-over is the ONLY place raw FHIR / JSON lives. All Inspect
 * renderers, the About panel, the backend toggle, and the audit/IO rendering are
 * preserved from the prior controller; only the surface state machine, the three
 * beats, their handlers, and reset are rewritten.
 */
(function () {
  var store = APIX.store;

  /* ============================ STATE ==================================== */
  var BEATS = [
    { key: 1, label: 'The change' },
    { key: 2, label: 'Send via APIX' },
    { key: 3, label: 'Auto-check' },
    { key: 4, label: 'Decision' }
  ];
  var beat = 1;                 // 1 | 2 | 3 | 4
  var doneBeat = {};            // beat number -> true when completed
  var inFlight = false;         // a handler is awaiting (guards double-clicks)

  var changeView = 'document';  // 'document' | 'data' (Beat 1 toggle)
  var sent = false;             // the submit chain has completed (Beat 2)
  var batchKey = 'good';        // 'good' | 'bad' — the screened batch
  var batchChecked = false;     // the auto-check has completed at least once
  var checkDone = false;        // the current evaluation has finished (verdict shown)
  var infoAsked = false;        // an Information Request round was opened
  var decided = null;           // 'approve' | 'reject'
  var aiRun = false;            // the AI assessment has been streamed

  var reached = {};             // status code -> Date (for elapsed)
  var lastNotif = null;         // most recent notification (Inspect focus)
  var ioEntries = [];           // captured { request, response } interactions
  var auditEntries = [];        // audit records (Inspect only)

  function el(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function now() { return new Date(); }
  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function reduced() { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; }

  /* The proposed limit as a short readable "≤ 1.5%" (derived, never hard-coded):
     read the Water Content check row's criterion off the engine. */
  function proposedLimit() {
    var w = APIX.pqi.validate(batchKey).filter(function (r) { return /Water/.test(r.test); })[0];
    return w ? w.criterion.replace(/\s*w\/w$/, '') : '≤ 1.5%';   // "≤ 1.5%"
  }
  function waterCheck() {
    return APIX.pqi.validate(batchKey).filter(function (r) { return /Water/.test(r.test); })[0];
  }
  function batchLabel() { return (APIX.pqi.batches[batchKey] || {}).label || batchKey; }

  /* ====================== BREADCRUMB ==================================== */
  function renderCrumb() {
    el('crumb').innerHTML = BEATS.map(function (b) {
      var state = doneBeat[b.key] ? 'done' : (beat === b.key ? 'now' : 'future');
      var mark = state === 'done' ? '<span class="cr-mark">✓</span>' : '';
      return '<span class="cr-step cr-' + state + '">' +
        '<span class="cr-n">' + b.key + '</span>' +
        '<span class="cr-l">' + esc(b.label) + '</span>' + mark + '</span>';
    }).join('<span class="cr-sep"></span>');
  }

  /* ============================ RENDER ================================== */
  function render() {
    renderCrumb();
    if (inFlight && beat === 2 && !sent) return;   // exchange animation owns the stage
    if (beat === 1) return renderBeat1();
    if (beat === 2) return renderBeat2();
    if (beat === 3) return renderBeat3();
    if (beat === 4) return renderBeat4();
  }

  /* ----------------------- BEAT 1 — The change ------------------------- */
  function renderBeat1() {
    var c = APIX.pqi.CHANGE;
    var after = c.after.replace(/^NMT\s*/, '').replace(/\s*w\/w$/, '');   // "1.5%"
    var before = c.before.replace(/^NMT\s*/, '').replace(/\s*w\/w$/, ''); // "2.0%"

    var docBody = '<p class="chg-sentence">Water content, measured at the end of the tablet’s shelf life, ' +
      'must now be no more than <span class="chg-new">' + esc(after) + '</span> — tightened from ' +
      '<span class="chg-old">' + esc(before) + '</span>.</p>';

    var dataBody = '<dl class="chg-record">' +
      '<div><dt>Test</dt><dd>Water content</dd></div>' +
      '<div><dt>Limit</dt><dd><strong>≤ ' + esc(after) + '</strong> <span class="chg-was">(was ≤ ' + esc(before) + ')</span></dd></div>' +
      '<div><dt>When</dt><dd>End of shelf life</dd></div>' +
      '<div><dt>Method</dt><dd>Karl Fischer (USP &lt;921&gt;)</dd></div>' +
      '</dl>';

    el('beat').innerHTML =
      '<div class="actor">SynthPharma · drug maker</div>' +
      '<h2 class="b-head">Tightening a quality limit on Velexa tablets.</h2>' +
      '<div class="toggle" role="group" aria-label="View">' +
        '<button class="tg-opt' + (changeView === 'document' ? ' on' : '') + '" data-view="document">Document</button>' +
        '<button class="tg-opt' + (changeView === 'data' ? ' on' : '') + '" data-view="data">Data</button>' +
      '</div>' +
      '<div class="chg-panel">' + (changeView === 'document' ? docBody : dataBody) + '</div>' +
      '<p class="chg-caption">The same fact — a person can read it, and so can a computer. ' +
        '<button class="link-btn" data-inspect="fhir">{ } View as FHIR</button></p>' +
      '<p class="b-why">Backed by 36-month stability data. A change FDA must review.</p>' +
      '<div class="b-controls">' +
        '<button class="btn-primary" data-act="send">Send to FDA →</button>' +
      '</div>';
  }

  /* ----------------------- BEAT 2 — Send & check ----------------------- */
  /* The exchange animation: SynthPharma —▸ token —▸ FDA, two ticks in sequence. */
  function exchangeShell(arrived, checked) {
    return '<div class="exchange">' +
      '<div class="ex-node">SynthPharma</div>' +
      '<div class="ex-wire' + (sent ? ' ex-wire-on' : '') + '"><span class="ex-token"></span></div>' +
      '<div class="ex-node">FDA</div>' +
      '</div>' +
      '<div class="ex-ticks">' +
        '<div class="ex-tick' + (arrived ? ' on' : '') + '"><span class="ex-c">✓</span> Received</div>' +
        '<div class="ex-tick' + (checked ? ' on' : '') + '"><span class="ex-c">✓</span> Checked automatically <small>(format &amp; completeness)</small></div>' +
      '</div>';
  }

  /* The shared regulatory case number the engine stamps on submit (real). */
  function caseNo() {
    try {
      var id = (store.task.identifier || []).filter(function (i) { return i.system === APIX.SYS.procedureSystem; })[0];
      return id ? id.value : '215123/S-005';
    } catch (e) { return '215123/S-005'; }
  }

  /* What APIX actually does on "send", and why it's a step-change. This is the
     heart of the talk — keep it concrete and lay-readable, never a feature dump. */
  function apixStoryHtml() {
    var steps = [
      ['Packaged as structured data', 'every limit, method and result as fields a computer can read — not prose buried in a PDF.'],
      ['Sent over a live API', 'a real call straight into FDA’s system — no portal upload, no email, no posting paper.'],
      ['Tracked as one shared case', 'applicant and FDA watch the very same record — ending the “where’s my submission?” emails.'],
      ['Updates pushed back in real time', 'every status change lands the instant FDA makes it — nobody logs in to check.']
    ];
    var li = steps.map(function (s, i) {
      return '<li style="animation-delay:' + (i * 90) + 'ms"><span class="ax-n">' + (i + 1) + '</span>' +
        '<div><b>' + esc(s[0]) + '</b><span>' + esc(s[1]) + '</span></div></li>';
    }).join('');

    var rows = [
      ['Format', 'A PDF document', 'Structured data'],
      ['Delivery', 'Uploaded to a portal', 'A live API call'],
      ['Checking', 'Re-typed &amp; read by hand', 'Read &amp; checked by machine'],
      ['Status', 'Chase it by email', 'Pushed in real time']
    ];
    var ba = rows.map(function (r) {
      return '<tr><th>' + r[0] + '</th><td class="ba-old">' + r[1] + '</td><td class="ba-new">' + r[2] + '</td></tr>';
    }).join('');

    return '<h2 class="b-head">SynthPharma didn’t email a PDF. APIX sent it as live data.</h2>' +
      '<p class="apix-case">Tracked as case <code>' + esc(caseNo()) + '</code>, shared by both sides. ' +
        '<button class="link-btn" data-inspect="wrapper">{ } see the live API call &amp; payload</button></p>' +
      '<ol class="apix-steps">' + li + '</ol>' +
      '<div class="apix-why">' +
        '<div class="apix-why-cap">Why it’s a game-changer</div>' +
        '<table class="ba"><thead><tr><th></th><th>The old way</th><th>With APIX</th></tr></thead>' +
        '<tbody>' + ba + '</tbody></table></div>';
  }

  function renderBeat2() {
    el('beat').innerHTML =
      exchangeShell(sent, sent) +
      apixStoryHtml() +
      '<div class="b-controls">' +
        '<button class="btn-primary" data-act="to-check">See FDA’s system read it →</button>' +
      '</div>';
  }

  /* ----------------------- BEAT 3 — the automatic check ---------------- */
  /* The strongest proof of why structured data matters: the moment the batch
     data lands, FDA's system evaluates the WHOLE finished-product specification
     against the real acceptance criteria — streaming a verdict per parameter and
     flagging any drift instantly. Auto-runs on entry; one narrative control. */
  function evalRowsHtml(key, resolved) {
    return APIX.pqi.validate(key).map(function (r, i) {
      var done = resolved === 'all' || i < resolved;
      var cls = done ? (r.pass ? ' ev-pass' : ' ev-fail') : '';
      var v = !done ? '<span class="ev-spin"></span>'
                    : (r.pass ? '<span class="ev-tick">✓</span>' : '<span class="ev-cross">✗</span>');
      return '<div class="ev-row' + cls + '" id="ev-row-' + i + '">' +
        '<div class="ev-param">' + esc(r.test) + '</div>' +
        '<div class="ev-crit">' + esc(r.criterion) + '</div>' +
        '<div class="ev-meas">' + esc(r.measured) + '</div>' +
        '<div class="ev-verdict">' + v + '</div></div>';
    }).join('');
  }

  function verdictHtml(key) {
    var rows = APIX.pqi.validate(key);
    var fail = rows.filter(function (r) { return !r.pass; });
    if (!fail.length) {
      return '<div class="ev-banner ev-ok"><strong>Batch conforms.</strong> ' +
        'All ' + rows.length + ' limits met — cleared for assessment automatically, the instant the data arrived.</div>';
    }
    var f = fail[0];
    return '<div class="ev-banner ev-bad"><strong>Non-conformance flagged.</strong> ' +
      esc(f.test.replace(/\s*\(.*\)/, '')) + ' measured ' + esc(f.measured) + ', outside the ' +
      esc(f.criterion.replace(/\s*w\/w$/, '')) + ' limit.' +
      '<span class="ev-bad-em">Caught the moment the data arrived — not left in a PDF for a reviewer to spot.</span></div>';
  }

  function renderBeat3() {
    var isBad = batchKey === 'bad';
    var switchBtn = checkDone
      ? '<button class="btn-ghost" data-act="switch">' +
          (isBad ? '← Back to the conforming batch' : 'Now screen an out-of-spec batch →') + '</button>'
      : '';
    var nextBtn = '<button class="btn-primary" data-act="to-decision"' +
      (checkDone ? '' : ' disabled') + '>FDA decides →</button>';

    el('beat').innerHTML =
      '<div class="actor">FDA · automated screening</div>' +
      '<h2 class="b-head">The instant the data lands, FDA’s system checks every limit.</h2>' +
      '<p class="b-why ev-sub">The submitted specification and the batch’s results are both structured data, ' +
        'so the system compares them itself — no reviewer re-typing values or cross-reading a PDF. ' +
        '<button class="link-btn" data-inspect="batch">see the acceptance criteria { }</button></p>' +
      '<div class="ev-panel">' +
        '<div class="ev-head"><span class="ev-title">Finished-product specification</span>' +
          '<span class="ev-batch">' + esc(batchLabel()) + '</span>' +
          '<span class="ev-status" id="ev-status">' + (checkDone ? '' : 'Evaluating…') + '</span></div>' +
        '<div class="ev-row ev-colhead"><div class="ev-param">Parameter</div>' +
          '<div class="ev-crit">Acceptance criterion</div><div class="ev-meas">Batch result</div>' +
          '<div class="ev-verdict"></div></div>' +
        evalRowsHtml(batchKey, checkDone ? 'all' : 0) +
      '</div>' +
      (checkDone ? verdictHtml(batchKey) : '') +
      '<div class="b-controls">' + switchBtn + nextBtn + '</div>';
  }

  /* ----------------------- BEAT 4 — Decision + AI ---------------------- */
  function renderBeat4() {
    var convo = infoAsked ? rsiHtml() : '';
    var payoff = decided ? payoffHtml() : '';
    var decisionBlock = decided ? '' :
      '<div class="decision-row">' +
        '<button class="btn-primary" data-decision="approve">Approve</button>' +
        '<button class="btn-ghost" data-decision="info"' + (infoAsked ? ' disabled' : '') + '>Send Information Request</button>' +
        '<button class="btn-ghost" data-decision="reject">Issue Complete Response</button>' +
      '</div>' +
      '<div class="rsi">' + convo + '</div>';

    el('beat').innerHTML =
      '<div class="actor">FDA</div>' +
      '<h2 class="b-head">FDA decides.</h2>' +
      decisionBlock + payoff +
      aiPanelHtml();
  }
  /* Beat 4 dispatch alias kept distinct from the auto-check (Beat 3). */

  /* The two-message Information Request exchange (real engine text). */
  function rsiHtml() {
    var answered = !!doneBeat.answered;
    var q = '<div class="msg msg-ha"><div class="msg-from">FDA</div>' +
      '<div class="msg-body">' + esc(APIX.RSI.question) + '</div></div>';
    var a = answered
      ? '<div class="msg msg-sponsor"><div class="msg-from">SynthPharma</div>' +
          '<div class="msg-body">' + esc(APIX.RSI.answer) + '</div></div>'
      : '<div class="b-controls"><button class="btn-ghost" data-act="answer">Send sponsor reply</button></div>';
    return q + a;
  }

  function fmtElapsed(ms) {
    if (ms == null) return '—';
    if (ms < 1000) return ms + ' ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + ' s';
    return (ms / 60000).toFixed(1) + ' min';
  }
  function elapsedStr() {
    var first = reached['submitted'];
    var last = reached['approved'] || reached['rejected'] || now();
    return (first) ? fmtElapsed(last - first) : '—';
  }

  function payoffHtml() {
    var msg = decided === 'approve'
      ? 'Approved in ' + esc(elapsedStr()) + ' — every step recorded and audited.'
      : 'Complete Response — not approved (in ' + esc(elapsedStr()) + '). Every step recorded and audited.';
    return '<div class="payoff"><p class="payoff-head">' + msg +
      ' <button class="link-btn" data-inspect="audit">audit trail { }</button></p></div>';
  }

  /* The AI panel — always available in Beat 3. Output streams from real data. */
  function aiPanelHtml() {
    return '<div class="ai-panel">' +
      '<div class="ai-head"><h3>AI-assisted review</h3>' +
        '<span class="ai-tag">illustrative · FDA draft AI guidance, Jan 2025</span></div>' +
      '<div class="b-controls"><button class="btn-ghost" data-act="ai">Run AI assessment</button></div>' +
      '<pre class="ai-out" id="ai-out" hidden></pre>' +
      '<p class="ai-foot">The AI reads the data and drafts; the reviewer decides. ' +
        'A narrow, low-risk use. (FDA draft AI guidance, Jan 2025.)</p>' +
      '</div>';
  }

  /* Build the AI assessment text from the real, currently-selected batch values. */
  function aiText() {
    var w = waterCheck();
    var limit = proposedLimit();                 // "≤ 1.5%"
    var lines = [
      'Reading the structured submission…',
      'Proposed limit: water ' + limit + ' at end of shelf life.',
      'Tested ' + batchLabel() + ': measured ' + w.measured + ' — ' +
        (w.pass ? 'within the limit.' : 'above the limit.')
    ];
    if (w.pass) {
      lines.push('Assessment: this batch meets the proposed criterion.');
      lines.push('Recommendation: data support approval; no additional batch data needed on this point.');
    } else {
      lines.push('Assessment: this batch does not meet the proposed criterion.');
      lines.push('Recommendation: do not approve on this batch; request additional batch data.');
    }
    return lines.join('\n');
  }

  /* ============================ HANDLERS =============================== */
  async function runAct(actKey) {
    if (inFlight) return;
    if (actKey === 'send')        return doSend();
    if (actKey === 'to-check')    return doToCheck();
    if (actKey === 'switch')      return doSwitchBatch();
    if (actKey === 'to-decision') return doToDecision();
    if (actKey === 'answer')      return doAnswer();
    if (actKey === 'ai')          return runAi();
  }

  function setView(v) { if (inFlight) return; changeView = v; renderBeat1(); }

  /* --- Beat 1 → 2: the REAL submit chain, then the received/checked exchange. */
  async function doSend() {
    doneBeat[1] = true;
    beat = 2;
    inFlight = true;
    renderCrumb();
    el('beat').innerHTML = exchangeShell(false, false) +
      '<p class="ex-status">Sending…</p>';
    // kick the token animation on the next frame
    if (!reduced()) { sent = true; var w = el('beat').querySelector('.ex-wire'); if (w) w.classList.add('ex-wire-on'); }

    try {
      // Author the structured content (fires the real $translate calls into Inspect),
      // then run the genuine connect → submit → subscribe chain.
      APIX.terminology.rows().forEach(function (r, n) {
        setTimeout(function () { APIX.client.translate(r.source.system, r.source.code); }, 30 * n);
      });
      APIX.pqi.normalize();

      await store.connect();
      await store.submit();
      if (!reached['submitted']) reached['submitted'] = now();

      await store.subscribe();
      if (!reduced()) await delay(520);

      // arrival tick
      await store.updateTask({ type: 'updateTask', status: 'received', businessStatus: 'received', addProcedureNo: true, addOutputs: ['ack'] });
      sent = true;
      el('beat').querySelector('.ex-ticks').firstChild.classList.add('on');
      if (!reduced()) await delay(480);

      // automatic conformance check tick
      await store.updateTask({ type: 'updateTask', status: 'accepted', businessStatus: 'validation-successful', addOutputs: ['validation'], flexibility: true });
      var ticks = el('beat').querySelectorAll('.ex-tick');
      if (ticks[1]) ticks[1].classList.add('on');
      if (!reduced()) await delay(360);

      sent = true;
      inFlight = false;
      renderBeat2();
    } catch (e) {
      inFlight = false;
      el('beat').innerHTML = '<p class="b-why">The submission could not be completed.</p>' +
        '<div class="b-controls"><button class="btn-ghost" data-act="send">Try again</button></div>';
    }
  }

  /* --- Beat 2 → 3: advance the real Task to under-assessment, then evaluate. */
  async function doToCheck() {
    doneBeat[2] = true;
    beat = 3;
    batchKey = 'good';                 // open on the representative batch
    inFlight = true;
    renderCrumb();
    try {
      await store.updateTask({ type: 'updateTask', status: 'in-progress', businessStatus: 'under-assessment' });
    } catch (e) { /* the comparison itself is local */ }
    await runEval();
  }

  /* Stream a verdict per parameter against the real acceptance criteria. */
  async function runEval() {
    inFlight = true;
    checkDone = false;
    renderBeat3();                      // skeleton: spinners + "Evaluating…"
    var rows = APIX.pqi.validate(batchKey);
    if (reduced()) {
      checkDone = true; batchChecked = true; inFlight = false; renderBeat3(); return;
    }
    await delay(440);
    for (var i = 0; i < rows.length; i++) {
      var row = el('ev-row-' + i);
      if (row) {
        row.classList.add(rows[i].pass ? 'ev-pass' : 'ev-fail');
        var v = row.querySelector('.ev-verdict');
        if (v) v.innerHTML = rows[i].pass ? '<span class="ev-tick">✓</span>' : '<span class="ev-cross">✗</span>';
      }
      var stat = el('ev-status');
      if (stat) stat.textContent = 'Checking ' + (i + 1) + ' of ' + rows.length + '…';
      await delay(autoCheckPause(rows[i]));
    }
    await delay(340);
    checkDone = true; batchChecked = true; inFlight = false;
    renderBeat3();                      // verdict banner + enabled controls
  }
  /* Linger a touch longer on a failing row so the room registers the catch. */
  function autoCheckPause(r) { return r.pass ? 460 : 760; }

  async function doSwitchBatch() {
    if (inFlight) return;
    batchKey = (batchKey === 'good') ? 'bad' : 'good';
    await runEval();
  }

  function doToDecision() {
    doneBeat[3] = true;
    beat = 4;
    render();
  }

  /* --- Beat 4: FDA decision. --- */
  async function onDecision(kind) {
    if (inFlight || beat !== 4 || decided) return;
    if (kind === 'info' && infoAsked) return;
    inFlight = true;
    try {
      if (kind === 'approve') {
        await store.updateTask({ type: 'updateTask', status: 'completed', businessStatus: 'approved', taskCode: 'approval', addOutputs: ['approval', 'assessment'] });
        decided = 'approve';
        doneBeat[4] = true;
      } else if (kind === 'reject') {
        await store.updateTask({ type: 'updateTask', status: 'completed', businessStatus: 'rejected', taskCode: 'rejection', addOutputs: ['rejection'], statusReason: 'Complete Response: the tested batch did not meet the proposed limit.' });
        decided = 'reject';
        doneBeat[4] = true;
      } else if (kind === 'info') {
        await store.updateTask({ type: 'updateTask', status: 'on-hold', businessStatus: 'clock-stop', taskCode: 'information-request' });
        infoAsked = true;
      }
    } catch (e) { /* surface stays usable */ }
    inFlight = false;
    renderBeat4();
  }

  async function doAnswer() {
    if (inFlight) return;
    inFlight = true;
    try {
      await store.updateTask({ type: 'updateTask', status: 'in-progress', businessStatus: 'clock-restart', taskCode: 'response-to-questions' });
      doneBeat.answered = true;
    } catch (e) { /* keep going */ }
    inFlight = false;
    renderBeat4();
  }

  /* --- The AI demo: stream the data-derived assessment, word by word. --- */
  async function runAi() {
    var out = el('ai-out');
    if (!out) return;
    var btn = el('beat').querySelector('[data-act="ai"]');
    if (btn) btn.disabled = true;
    aiRun = true;
    out.hidden = false;
    var text = aiText();
    if (reduced()) { out.textContent = text; if (btn) btn.disabled = false; return; }
    out.textContent = '';
    var tokens = text.split(/(\s+)/);   // keep whitespace so line breaks survive
    for (var i = 0; i < tokens.length; i++) {
      out.textContent += tokens[i];
      if (tokens[i].trim()) await delay(38);
    }
    if (btn) btn.disabled = false;
  }

  /* ===================================================================== */
  /* ============================ INSPECT ================================= */
  /* The ONLY place FHIR / JSON appears. Renderers below keep full R5 fidelity. */
  function openInspect() { el('inspect').hidden = false; el('inspect-toggle').setAttribute('aria-expanded', 'true'); el('inspect-toggle').classList.add('on'); }
  function closeInspect() { el('inspect').hidden = true; el('inspect-toggle').setAttribute('aria-expanded', 'false'); el('inspect-toggle').classList.remove('on'); }
  function toggleInspect() { if (el('inspect').hidden) openInspect(); else closeInspect(); }

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
    'submitted': 'Submitted — the supplement has been sent to FDA via the gateway and awaits acknowledgement.',
    'received': 'Received — FDA has acknowledged receipt of the supplement.',
    'validation-successful': 'Filed — the supplement is complete and accepted for review (21 CFR 314.101).',
    'under-assessment': 'Under review — an FDA reviewer is assessing the structured specification.',
    'clock-stop': 'On hold — review paused pending the sponsor’s response to an FDA Information Request.',
    'clock-restart': 'Review resumed — the sponsor has responded to the Information Request.',
    'approved': 'Approved — FDA approved the supplement; the specification change takes effect.',
    'rejected': 'Not approved — FDA issued a Complete Response Letter (grounds in the letter).'
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
    var codeCode = (t.code && t.code.coding && t.code.coding[0]) ? t.code.coding[0].code : '';
    var codeDisp = codeCode === 'supplement' ? 'Prior Approval Supplement'
      : ((t.code && t.code.coding && t.code.coding[0]) ? t.code.coding[0].display : '');
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
          '<span class="tk-v"><strong>' + esc(codeDisp || 'Prior Approval Supplement') + '</strong></span></div>' +
        '<div class="tk-row"><span class="tk-k">Status</span>' +
          '<span class="tk-v"><span class="badge badge-status">' + esc(t.status) + '</span>' +
          ' <span class="badge badge-biz">' + esc(bizDisp) + '</span></span></div>' +
        (gloss ? '<div class="tk-gloss">' + esc(gloss) + '</div>' : '') +
        (reason ? '<div class="tk-gloss tk-reason"><strong>Grounds:</strong> ' + esc(reason) + '</div>' : '') +
        '<div class="tk-row"><span class="tk-k">Supplement number</span><span class="tk-v"><code>' + esc(procNo || 'not yet assigned') + '</code></span></div>' +
        '<div class="tk-row"><span class="tk-k">Review thread</span><span class="tk-v"><code>' + esc(groupId || '—') + '</code> <small>(group identifier)</small></span></div>' +
        '<div class="tk-row"><span class="tk-k">Requester</span><span class="tk-v">' + esc(requester) + ' <small>(sponsor)</small></span></div>' +
        '<div class="tk-row"><span class="tk-k">Performer</span><span class="tk-v">' + esc(performer) + ' <small>(FDA)</small></span></div>' +
        '<div class="tk-row tk-block"><span class="tk-k">Input documents</span><span class="tk-v">' + taskDocsList(t.input) + '</span></div>' +
        '<div class="tk-row tk-block"><span class="tk-k">Output documents</span><span class="tk-v">' + taskDocsList(t.output, 'PDF') + '</span></div>' +
      '</div>' +
      '<button class="link-btn tk-raw-toggle" id="tk-raw-toggle">Show raw FHIR JSON</button>' +
      '<pre class="modal-json tk-raw" id="tk-raw" hidden>' + APIX.highlight(t) + '</pre>';
    el('inspect-focus').innerHTML = '<div class="if-title">Task — Prior Approval Supplement</div>' + card;
  }

  /* APIX wrapper view — Task ▸ DocumentReference ▸ Binary (base64, real decode)
     ▸ PQI Bundle. */
  function renderWrapperFocus() {
    var t = store.task;
    var docref = store.get('DocumentReference/docref-spec-fhir');
    var bin = store.get('Binary/binary-spec-fhir');
    var bizDisp = (t && t.businessStatus && t.businessStatus.coding && t.businessStatus.coding[0]) ? t.businessStatus.coding[0].display : '—';
    var codeCode2 = (t && t.code && t.code.coding && t.code.coding[0]) ? t.code.coding[0].code : '';
    var codeDisp = codeCode2 === 'supplement' ? 'Prior Approval Supplement'
      : ((t && t.code && t.code.coding && t.code.coding[0]) ? t.code.coding[0].display : 'Prior Approval Supplement');
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
            '<span><code>requester</code> SynthPharma AG → <code>owner</code> FDA</span>' +
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
    var label = (APIX.pqi.batches[batchKey] || {}).label || batchKey;
    var rows = results.map(function (v) {
      return '<tr' + (v.pass ? '' : ' class="val-fail-row"') + '><td>' + esc(v.test) + '</td><td>' + esc(v.criterion) +
        '</td><td>' + esc(v.measured) + '</td><td class="' + (v.pass ? 'pass' : 'fail') + '">' +
        (v.pass ? 'PASS' : 'FAIL') + '</td></tr>';
    }).join('');
    var banner = anyFail
      ? '<div class="val-banner val-banner-fail">FAILS PROPOSED CRITERION</div>'
      : '<div class="val-banner val-banner-pass">All criteria met</div>';
    el('inspect-focus').innerHTML =
      '<div class="if-title">Acceptance criteria — batch vs. structured ObservationDefinitions</div>' +
      '<div class="val-sub">' + esc(label) + '</div>' + banner +
      '<table class="val-table"><thead><tr><th>Test</th><th>Criterion</th><th>Measured</th><th>Result</th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table>';
  }

  function inspectKey(key) {
    if (key === 'task') renderTaskFocus();
    else if (key === 'harmonize') renderHarmonizeFocus();
    else if (key === 'wrapper') renderWrapperFocus();
    else if (key === 'batch') renderBatchFocus();
    else if (key === 'spec') renderWrapperFocus();
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
    beat = 1; doneBeat = {}; inFlight = false;
    changeView = 'document'; sent = false;
    batchKey = 'good'; batchChecked = false; checkDone = false; infoAsked = false; decided = null; aiRun = false;
    reached = {}; lastNotif = null; ioEntries = []; auditEntries = [];
    store.reset();
    renderAudit();
    el('io-list').innerHTML = '';
    el('inspect-focus').innerHTML = '';
    setIoCount();
    closeInspect();
    render();
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
    var ins = ev.target.closest('[data-inspect]'); if (ins) { inspectKey(ins.getAttribute('data-inspect')); return; }
    var vw = ev.target.closest('[data-view]'); if (vw) { setView(vw.getAttribute('data-view')); return; }
    var dec = ev.target.closest('[data-decision]'); if (dec) { onDecision(dec.getAttribute('data-decision')); return; }
    var a = ev.target.closest('[data-act]'); if (a) { runAct(a.getAttribute('data-act')); return; }
  });

  el('resetbtn').addEventListener('click', resetAll);
  el('inspect-toggle').addEventListener('click', toggleInspect);
  el('inspect-close').addEventListener('click', closeInspect);
  el('about-btn').addEventListener('click', function () { el('inspect-focus').innerHTML = ABOUT_HTML; openInspect(); });
  el('backend-mock').addEventListener('click', function () { setBackend('mock'); });
  el('backend-live').addEventListener('click', function () { setBackend('hapi'); });
  el('backend-local').addEventListener('click', function () { setBackend('local'); });
  el('local-base').addEventListener('change', function () { syncLocalBase(); if (isLocal()) resetAll(); });

  reflectBackend();
  render();
})();
