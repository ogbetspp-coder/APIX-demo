/*
 * UI controller — two role panes + a shared status spine, one prominent action
 * at a time, one Inspect slide-over for all FHIR / API detail.
 *
 * The FHIR data layer (APIX.store / APIX.client / APIX.pqi / APIX.terminology)
 * is unchanged; this file only renders it. Layout:
 *   - STATUS SPINE  : Draft → Submitted → Received → Validated → Assessing → Decision
 *   - INDUSTRY pane : ① Author (harmonize + consolidated spec) ② Submit ③ Track
 *   - HA pane       : ① Received ② Review (PDF / validate) ③ Decide
 *   - FOOTER        : narration + one primary "Next →"; parks for the decision
 *   - INSPECT       : focus resource/request + running 'io' call list
 */
(function () {
  var store = APIX.store;
  var S = APIX.scenario;
  var i = 0;                  // current step index

  var reached = {};          // businessStatus code -> Date reached (spine + cycle time)
  var lastNotif = null;      // most recent notification Bundle (Inspect focus)
  var inFlight = false;      // a step handler is awaiting (live latency guard)
  var decisionPending = false; // ▶ engine has handed off to the HA decision buttons
  var infoRoundDone = false; // a Request-information Q&A loop has already completed
  var terminalNarration = null;

  var ioEntries = [];        // captured { request, response } interactions
  var batchKey = 'good';     // regulator's selected tested batch (good | bad)
  var specMode = 'doc';      // consolidated spec view (doc | fhir)

  function el(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function bytes(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.round(n / 1e3) + ' KB'; }
  function show(id) { el(id).hidden = false; }
  function hide(id) { el(id).hidden = true; }

  /* Which actor owns a step (drives the subtle pane emphasis). */
  function actorOf(step) { return step ? step.actor : null; }

  /* ============================ STATUS SPINE =============================== */
  /* Draft/Author → businessStatusFlow → Decision. The whole exchange is just
     this advancing: current navy, reached get a check + timestamp, future muted. */
  var SPINE = [{ code: 'draft', label: 'Draft' }]
    .concat(APIX.businessStatusFlow.map(function (m) { return { code: m.code, label: m.label }; }))
    .concat([{ code: 'decision', label: 'Decision' }]);

  /* Resolve which spine node is "current" from the step about to run. */
  function spineCurrent() {
    var step = S[i];
    if (!step) return reached['rejected'] ? 'decision' : 'decision';
    switch (step.effect.type) {
      case 'pull': case 'normalize': case 'render':
      case 'connect': case 'submit': case 'subscribe': return 'draft';
      case 'decision': return 'decision';
      case 'updateTask': return step.effect.businessStatus;
      default: return 'draft';
    }
  }

  function renderSpine() {
    var cur = spineCurrent();
    var html = SPINE.map(function (n) {
      var done = (n.code === 'draft')
        ? (i > 2 || !!reached['submitted'])               // Draft is "done" once we've left Act 1
        : (n.code === 'decision')
          ? (!!reached['approved'] || !!reached['rejected'])
          : !!reached[n.code];
      var isCur = (n.code === cur) && !done;
      var ts = (n.code !== 'draft' && n.code !== 'decision' && reached[n.code])
        ? reached[n.code].toLocaleTimeString() : '';
      var cls = 'sp-node' + (done ? ' done' : '') + (isCur ? ' cur' : '');
      return '<div class="' + cls + '">' +
        '<span class="sp-mark"></span>' +
        '<span class="sp-lbl">' + esc(n.label) + '</span>' +
        (ts ? '<span class="sp-ts">' + esc(ts) + '</span>' : '') +
        '</div>';
    }).join('<span class="sp-sep"></span>');
    el('spine').innerHTML = html;
  }

  /* ======================= PANE EMPHASIS (calm) =========================== */
  function setActivePane(actor) {
    el('pane-ind').classList.toggle('is-active', actor === 'applicant');
    el('pane-ha').classList.toggle('is-active', actor === 'regulator');
  }

  /* ============================ CONTROLS ================================== */
  function refreshControls() {
    renderSpine();
    if (decisionPending) { lockStepForDecision(); return; }
    var step = S[i];
    if (step) {
      setActivePane(actorOf(step));
      el('narration').textContent = step.narration;
      el('stepbtn').innerHTML = esc(step.button) + ' &rarr;';
      el('stepbtn').disabled = false;
      el('progress').textContent = 'Step ' + (i + 1) + ' / ' + S.length;
    } else {
      setActivePane(null);
      el('narration').innerHTML = terminalNarration ||
        '<strong>Done — end to end in minutes.</strong> Every status change was timestamped, and APIX carried both the PDF and the structured FHIR over the same rails.';
      el('stepbtn').innerHTML = 'Done';
      el('stepbtn').disabled = true;
      el('progress').textContent = 'Complete';
    }
  }

  /* While the decision is the regulator's, the ▶ engine is parked: the footer
     button is disabled and the three HA Decide buttons drive the transition. */
  function lockStepForDecision() {
    setActivePane('regulator');
    el('stepbtn').innerHTML = 'Pick a decision &rarr;';
    el('stepbtn').disabled = true;
    el('narration').innerHTML = '<strong>Over to the regulator.</strong> On the Health Authority pane, pick an outcome: ' +
      '<strong>Approve</strong>, <strong>Request information</strong> (a clock-stop Q&amp;A loop), or <strong>Reject</strong>. Nothing auto-approves.';
  }

  /* Run the current step. Handlers may be async (live mode does real network
     I/O); await before advancing `i`, and guard against a fast double-click. */
  async function runStep() {
    if (inFlight || decisionPending) return;
    var step = S[i];
    if (!step) return;

    inFlight = true;
    var btn = el('stepbtn');
    btn.disabled = true; btn.classList.add('busy');

    try {
      switch (step.effect.type) {
        case 'pull': handlePull(); break;
        case 'normalize': handleNormalize(); break;
        case 'render': handleConsolidate(); break;
        case 'connect': await handleConnect(); break;
        case 'submit': await handleSubmit(); break;
        case 'subscribe': await handleSubscribe(); break;
        case 'updateTask':
          await store.updateTask(step.effect);
          afterRegStep(step);
          break;
        case 'decision':
          show('ha-decide');
          decisionPending = true;
          break;   // leave `i` unchanged; refreshControls() locks ▶
      }
      if (!decisionPending) i += 1;
    } catch (e) {
      el('narration').innerHTML = '<strong>Step failed:</strong> ' + esc(e && e.message ? e.message : String(e)) +
        (store._isLive() ? ' — the public HAPI server may be busy; retry, or switch back to Mock.' : '');
    } finally {
      inFlight = false;
      btn.classList.remove('busy');
    }
    refreshControls();
  }

  /* ============================ INDUSTRY ① Author ======================== */
  function handlePull() {
    show('ind-author');
    // Pull simply opens the authoring block; the harmonize table fills next step.
    el('harmonize').innerHTML = '<p class="step-cap">Source data lives in three local systems with their own codes. ' +
      'Next: harmonize each term to the PQI controlled vocabularies.</p>';
  }

  function relText(rel) {
    if (rel === 'equivalent') return 'equivalent';
    if (rel === 'source-is-narrower-than-target') return 'narrower → broader';
    if (rel === 'source-is-broader-than-target') return 'broader → narrower';
    return esc(rel);
  }

  /* Harmonize — a clean mapping table that fills one row at a time; each row
     fires a real ConceptMap/$translate (visible in Inspect). */
  function handleNormalize() {
    show('ind-author');
    var rows = APIX.terminology.rows();
    el('harmonize').innerHTML =
      '<table class="grid map-table"><thead><tr>' +
        '<th>Local term</th><th>PQI term</th><th>Relationship</th>' +
      '</tr></thead><tbody id="map-rows"></tbody></table>';
    var body = el('map-rows');
    rows.forEach(function (r, n) {
      var tr = document.createElement('tr');
      tr.className = 'map-row';
      tr.innerHTML =
        '<td><span class="m-disp">' + esc(r.source.display) + '</span> <code>' + esc(r.source.code) + '</code></td>' +
        '<td><span class="m-disp m-tgt">' + esc(r.target.display) + '</span> <code>' + esc(r.target.code) + '</code></td>' +
        '<td class="m-rel">' + relText(r.relationship) + '</td>';
      body.appendChild(tr);
      (function (row, node) {
        setTimeout(function () {
          node.classList.add('in');
          APIX.client.translate(row.source.system, row.source.code);
        }, 280 * n + 80);
      })(r, tr);
    });
    el('harmonize-cap').hidden = false;
  }

  /* Consolidated spec — compact table with the one changed row highlighted, plus
     an inline Document⇄FHIR toggle. */
  function renderConsolidated() {
    el('spec-seg').querySelector('[data-mode="doc"]').classList.toggle('on', specMode === 'doc');
    el('spec-seg').querySelector('[data-mode="fhir"]').classList.toggle('on', specMode === 'fhir');
    var body;
    if (specMode === 'fhir') {
      body = '<pre class="modal-json cons-json">' + APIX.highlight(APIX.pqi.bundle || APIX.pqi.normalize()) + '</pre>';
    } else {
      var rows = APIX.pqi.specRows().map(function (r) {
        var shelf = r.changed
          ? '<span class="diff-old">' + esc(r.before) + '</span> <span class="diff-new">' + esc(r.shelfLife) + ' w/w</span>'
          : esc(r.shelfLife);
        return '<tr' + (r.changed ? ' class="row-changed"' : '') + '>' +
          '<td>' + esc(r.test) + '</td><td>' + esc(r.release) + '</td><td>' + shelf + '</td></tr>';
      }).join('');
      body =
        '<p class="cons-change">Change in this variation: <strong>' + esc(APIX.pqi.CHANGE.label) + '</strong> — ' +
          '<span class="diff-old">' + esc(APIX.pqi.CHANGE.before) + '</span> → <span class="diff-new">' + esc(APIX.pqi.CHANGE.after) + '</span></p>' +
        '<table class="grid spec-table"><thead><tr><th>Test</th><th>Release</th><th>End of shelf life</th></tr></thead>' +
          '<tbody>' + rows + '</tbody></table>';
    }
    el('consolidated').innerHTML = body;
  }
  function handleConsolidate() {
    APIX.pqi.normalize();
    show('ind-spec');
    renderConsolidated();
  }

  /* ============================ INDUSTRY ②/③ ============================= */
  function docsHtml(inputs) {
    return inputs.map(function (inp) {
      var d = store.get(inp.valueReference.reference);
      var ct = d ? d.content[0].attachment.contentType : 'application/pdf';
      var size = d ? d.content[0].attachment.size : 0;
      var spec = inp.type.coding[0].code === '3.2.P.5.1';
      var ic = ct === 'application/fhir+json' ? 'FHIR' : 'PDF';
      return '<div class="doc' + (spec ? ' doc-spec' : '') + '"><span class="doc-ic">' + ic + '</span>' +
        '<span class="doc-title">' + esc(inp.valueReference.display) + '</span>' +
        '<span class="doc-size">' + bytes(size) + '</span>' +
        '<button class="link-btn" data-inspect="ref:' + esc(inp.valueReference.reference) + '">view</button></div>';
    }).join('');
  }

  async function handleConnect() {
    await store.connect();
    show('ind-author');
    // Connection is a quiet line in the Track feed once subscribed; for now just
    // record it as activity context.
    feed('Connected — Organization + Endpoint registered, Bearer token issued.');
    show('ind-track');
  }

  async function handleSubmit() {
    await store.submit();
    var t = store.task;
    show('ind-pkg');
    el('pkg').innerHTML =
      '<div class="pkg-head">' + t.input.length + ' documents carried by APIX ' +
        '<button class="link-btn" data-inspect="task">view Task</button>' + verifyLinkHtml() + '</div>' +
      docsHtml(t.input);
    show('ind-track');
    feed('Submitted Type IB variation — Task created and delivered to the Health Authority.');
  }

  function verifyLinkHtml() {
    if (!store.taskUrl) return '';
    return ' <a class="verify-link" href="' + esc(store.taskUrl) + '" target="_blank" rel="noopener">on public server ↗</a>';
  }

  async function handleSubscribe() {
    await store.subscribe();
    show('ind-track');
    feed('Subscribed to Task status changes — updates now arrive in real time, no polling.');
    if (!reached['submitted']) reached['submitted'] = new Date();
  }

  /* Track — a quiet one-line activity feed (newest at the bottom). */
  function feed(text, inspectKey) {
    show('ind-track');
    var row = document.createElement('div');
    row.className = 'feed-row';
    row.innerHTML = '<span class="feed-time">' + new Date().toLocaleTimeString() + '</span>' +
      '<span class="feed-msg">' + text + '</span>' +
      (inspectKey ? '<button class="link-btn" data-inspect="' + esc(inspectKey) + '">view</button>' : '');
    el('feed').appendChild(row);
    el('feed').scrollTop = el('feed').scrollHeight;
  }

  /* ============================ HEALTH AUTHORITY ========================== */
  function revealRegulator() {
    if (!store.task) return;
    hide('ha-empty');
    show('ha-content');
    el('reg-docs').innerHTML = '<div class="payload-head">Received documents</div>' + docsHtml(store.task.input);
    updateRegStatus(store.task);
  }

  function updateRegStatus(task) {
    el('reg-status').innerHTML =
      '<span class="rs-label">Task</span>' +
      '<span class="badge badge-status">' + esc(task.status) + '</span>' +
      '<span class="badge badge-biz">' + esc(task.businessStatus.coding[0].display) + '</span>' +
      (task.identifier.length > 1 ? '<span class="badge badge-proc">' + esc(task.identifier[1].value) + '</span>' : '') +
      ' <button class="link-btn" data-inspect="task">view Task</button>';
    if (task.output && task.output.length) {
      el('reg-outputs').innerHTML = '<div class="payload-head">Outputs sent back</div>' +
        task.output.map(function (o) {
          return '<div class="doc"><span class="doc-ic">PDF</span><span class="doc-title">' + esc(o.valueReference.display) + '</span></div>';
        }).join('');
    }
  }

  /* After a regulator updateTask step: reveal/advance the HA workflow blocks. */
  function afterRegStep(step) {
    revealRegulator();
    if (step.key === 'receive') { /* Received block visible */ }
    if (step.key === 'validate') { show('ha-review'); }
    if (step.key === 'assess') { /* assessment underway; Decide unlocks next */ }
  }

  /* Review — read the spec, validate the structured data with Good/Bad teeth. */
  function setBatch(key) {
    batchKey = key;
    el('batch-good').classList.toggle('on', key === 'good');
    el('batch-bad').classList.toggle('on', key === 'bad');
  }
  function openDoc(kind) {
    if (kind === 'pdf') {
      inspectFocus('Rendered eCTD 3.2.P.5.1 (PDF view)', APIX.pqi.renderSpecHtml(), true);
      openInspect();
    } else if (kind === 'validate') {
      renderValidation();
    }
  }
  function renderValidation() {
    var results = APIX.pqi.validate(batchKey);
    var anyFail = results.some(function (v) { return !v.pass; });
    var batchLabel = (APIX.pqi.batches[batchKey] || {}).label || batchKey;
    var rows = results.map(function (v) {
      return '<tr' + (v.pass ? '' : ' class="val-fail-row"') + '><td>' + esc(v.test) + '</td><td>' + esc(v.criterion) +
        '</td><td>' + esc(v.measured) + '</td><td class="' + (v.pass ? 'pass' : 'fail') + '">' +
        (v.pass ? 'PASS' : 'FAIL') + '</td></tr>';
    }).join('');
    var banner = anyFail
      ? '<div class="val-banner val-banner-fail">OUT OF SPECIFICATION — acceptance criterion breached</div>' +
        '<p class="val-punch">In the 300-page PDF this is buried; in the structured spec the acceptance criterion is <strong>machine-checked — caught at submit.</strong></p>'
      : '<div class="val-banner val-banner-pass">All acceptance criteria met</div>';
    el('review-result').innerHTML =
      '<div class="val-sub">' + esc(batchLabel) + ' vs. acceptance criteria</div>' +
      banner +
      '<table class="val-table"><thead><tr><th>Test</th><th>Criterion</th><th>Measured</th><th>Result</th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table>';
  }

  /* Decide — three real APIX outcomes (preserve decisionPending handoff). */
  function setDecisionBtns(enabled) {
    [].forEach.call(el('decision-btns').children, function (b) { b.disabled = !enabled; });
  }
  function finishDecision() {
    decisionPending = false;
    hide('ha-decide');
    i = S.length;                      // past the last step → completion
    refreshControls();
    setTimeout(renderSummary, 700);    // terminal tracker stamp lands ~520ms after
  }
  async function onDecision(kind) {
    if (!decisionPending || inFlight) return;
    inFlight = true; setDecisionBtns(false);
    try {
      if (kind === 'approve') {
        await store.updateTask({ type: 'updateTask', status: 'completed', businessStatus: 'approved', taskCode: 'approval', addOutputs: ['approval', 'assessment'] });
        terminalNarration = '<strong>Approved — end to end in minutes.</strong> Every status change was timestamped (cycle-time summary below), and APIX carried both the PDF and the structured FHIR over the same rails.';
        finishDecision();
      } else if (kind === 'reject') {
        await store.updateTask({ type: 'updateTask', status: 'completed', businessStatus: 'rejected', taskCode: 'rejection', addOutputs: ['rejection'] });
        terminalNarration = '<strong>Rejected — but still in minutes, fully tracked.</strong> The same APIX rails carry a negative decision; every phase is timestamped below.';
        finishDecision();
      } else if (kind === 'info') {
        if (infoRoundDone) { setDecisionBtns(true); return; }
        await store.updateTask({ type: 'updateTask', status: 'on-hold', businessStatus: 'clock-stop', taskCode: 'information-request' });
        await store.updateTask({ type: 'updateTask', status: 'in-progress', businessStatus: 'under-assessment', taskCode: 'response-to-questions' });
        infoRoundDone = true;
        el('narration').innerHTML = '<strong>Question answered — clock restarted.</strong> Now pick a final decision: Approve or Reject.';
        setDecisionBtns(true);
      }
    } catch (e) {
      el('narration').innerHTML = '<strong>Decision failed:</strong> ' + esc(e && e.message ? e.message : String(e));
      setDecisionBtns(true);
    } finally {
      inFlight = false;
    }
  }

  /* ===================== END SUMMARY (terminal only) ===================== */
  var CT_PHASES = [
    { from: 'submitted', to: 'received', label: 'Submitted → Received' },
    { from: 'received', to: 'validation-successful', label: 'Received → Validated' },
    { from: 'validation-successful', to: 'under-assessment', label: 'Validated → Assessing' },
    { from: 'under-assessment', to: 'approved', label: 'Assessing → Decision', altTo: 'rejected' }
  ];
  function fmtElapsed(ms) {
    if (ms < 1000) return ms + ' ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + ' s';
    return (ms / 60000).toFixed(1) + ' min';
  }
  function renderSummary() {
    var first = reached['submitted'];
    var rowsHtml = '', maxMs = 1, segs = [];
    CT_PHASES.forEach(function (p) {
      var a = reached[p.from], b = reached[p.to] || (p.altTo ? reached[p.altTo] : null);
      var ms = (a && b) ? (b - a) : null;
      if (ms != null && ms > maxMs) maxMs = ms;
      segs.push({ label: p.label, ms: ms });
    });
    segs.forEach(function (s) {
      var pct = s.ms != null ? Math.max(4, Math.round(100 * s.ms / maxMs)) : 0;
      rowsHtml += '<div class="ct-row"><span class="ct-lbl">' + esc(s.label) + '</span>' +
        '<span class="ct-bar"><span class="ct-fill" style="width:' + pct + '%"></span></span>' +
        '<span class="ct-val">' + (s.ms != null ? esc(fmtElapsed(s.ms)) : '—') + '</span></div>';
    });
    var last = reached['approved'] || reached['rejected'];
    var totalMs = (first && last) ? (last - first) : null;
    el('summary').hidden = false;
    el('summary').innerHTML =
      '<div class="sum-head">Cycle time — this run\'s real timestamps</div>' +
      '<div class="ct-bars">' + rowsHtml + '</div>' +
      '<div class="ct-total">Total (submit → decision): <strong>' + (totalMs != null ? esc(fmtElapsed(totalMs)) : '—') + '</strong>' +
        ' <span class="ct-baseline">vs. a typical manual variation measured in <em>weeks</em></span></div>' +
      '<ul class="adopt-list">' +
        '<li>One structured spec, carried as both a human PDF and machine-readable FHIR over the same rails.</li>' +
        '<li>Acceptance criteria are machine-checked at submit — out-of-spec is caught immediately, not buried in a PDF.</li>' +
        '<li>Every status change is pushed and timestamped, so cycle time becomes measurable analytics.</li>' +
      '</ul>';
    el('summary').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /* ============================ INSPECT ================================== */
  function openInspect() { el('inspect').hidden = false; el('inspect-toggle').setAttribute('aria-expanded', 'true'); el('inspect-toggle').classList.add('on'); }
  function closeInspect() { el('inspect').hidden = true; el('inspect-toggle').setAttribute('aria-expanded', 'false'); el('inspect-toggle').classList.remove('on'); }
  function toggleInspect() { if (el('inspect').hidden) openInspect(); else closeInspect(); }

  function inspectFocus(title, htmlOrObj, isHtml) {
    var body = isHtml ? htmlOrObj : '<pre class="modal-json">' + APIX.highlight(htmlOrObj) + '</pre>';
    el('inspect-focus').innerHTML = '<div class="if-title">' + esc(title) + '</div>' + body;
  }
  function inspectKey(key) {
    if (key === 'task') inspectFocus('Task — Type IB variation', store.task);
    else if (key === 'notif') inspectFocus('Subscription notification Bundle', lastNotif);
    else if (key === 'fhir') inspectFocus('PQI FHIR Bundle', APIX.pqi.bundle || APIX.pqi.normalize());
    else if (key.indexOf('ref:') === 0) {
      var ref = key.slice(4);
      var r = store.get(ref);
      if (r) inspectFocus(r.resourceType + (r.content ? ' — ' + r.content[0].attachment.title : ''), r);
    }
    openInspect();
  }

  /* Running list of real API calls (APIX.client 'io' events). */
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

  /* ============================ STORE EVENTS ============================= */
  store.bus.addEventListener('task', function (ev) {
    if (ev.detail.firstTime) {
      if (!reached['submitted']) reached['submitted'] = new Date();
    } else if (!el('ha-content').hidden) {
      updateRegStatus(ev.detail.task);
    }
  });
  store.bus.addEventListener('notification', function (ev) {
    lastNotif = ev.detail.bundle;
    var code = ev.detail.businessStatus;
    var msg = 'Status → ' + APIX.display('businessStatus', code);
    feed(msg, 'notif');
    setTimeout(function () {
      reached[code] = new Date();
      renderSpine();
    }, 520);
  });

  /* Real API calls feed the Inspect list. */
  APIX.client.bus.addEventListener('io', function (ev) { addIo(ev.detail); });

  /* ============================ RESET =================================== */
  function resetAll() {
    i = 0; reached = {}; lastNotif = null; ioEntries = [];
    decisionPending = false; infoRoundDone = false; terminalNarration = null;
    batchKey = 'good'; specMode = 'doc';
    store.reset();
    ['ind-author', 'ind-spec', 'ind-pkg', 'ind-track', 'ha-content', 'ha-review', 'ha-decide', 'summary'].forEach(hide);
    show('ha-empty');
    ['harmonize', 'consolidated', 'pkg', 'feed', 'reg-docs', 'reg-status', 'reg-outputs', 'review-result', 'io-list'].forEach(function (id) { el(id).innerHTML = ''; });
    el('harmonize-cap').hidden = true;
    setIoCount(); closeInspect();
    setBatch('good'); setDecisionBtns(true);
    refreshControls();
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

  /* ============================ ABOUT =================================== */
  var ABOUT_HTML =
    '<div class="if-title">About — Real vs Simulated</div>' +
    '<p class="muted">Built on real, valid FHIR R5 — independently verifiable.</p>' +
    '<table class="val-table about-table"><thead><tr><th>Aspect</th><th>Status</th></tr></thead><tbody>' +
    '<tr><td>FHIR R5 resources (Task, DocumentReference, Binary, Subscription, PQI Bundle)</td><td class="pass">Real &amp; conformant</td></tr>' +
    '<tr><td>Conformance to the APIX + PQI IGs (official HL7 validator)</td><td class="pass">Real (88 → 1 documented IG bug)</td></tr>' +
    '<tr><td><strong>Live</strong> mode: POST / GET / $validate over the wire</td><td class="pass">Real, against public hapi.fhir.org/baseR5</td></tr>' +
    '<tr><td><strong>Local HAPI</strong> mode: self-hosted R5 server</td><td class="pass">Real REST + real R5 WebSocket subscription push</td></tr>' +
    '<tr><td>OAuth2 / SMART Backend Services token</td><td class="sim">Simulated (labeled; orthogonal to the exchange)</td></tr>' +
    '<tr><td>Real-time push delivery</td><td class="sim">Public HAPI: UI reads the Task back. Local HAPI: real WebSocket push.</td></tr>' +
    '</tbody></table>' +
    '<p class="muted">Mock mode is the stage default: offline, deterministic, instant. ' +
    '<a href="https://build.fhir.org/ig/HL7/APIX---API-Exchange-for-Medicinal-Products/" target="_blank" rel="noopener">APIX conformance ↗</a></p>';

  /* ============================ WIRING ================================= */
  document.addEventListener('click', function (ev) {
    var sum = ev.target.closest('.io-sum');
    if (sum) { var det = sum.parentNode.querySelector('.io-detail'); if (det) det.hidden = !det.hidden; return; }
    var ins = ev.target.closest('[data-inspect]'); if (ins) { inspectKey(ins.getAttribute('data-inspect')); return; }
    var b = ev.target.closest('[data-batch]'); if (b) { setBatch(b.getAttribute('data-batch')); if (el('review-result').innerHTML) renderValidation(); return; }
    var dec = ev.target.closest('[data-decision]'); if (dec) { onDecision(dec.getAttribute('data-decision')); return; }
    var m = ev.target.closest('[data-mode]'); if (m) { specMode = m.getAttribute('data-mode'); renderConsolidated(); return; }
    var d = ev.target.closest('[data-doc]'); if (d) { openDoc(d.getAttribute('data-doc')); return; }
  });

  el('stepbtn').addEventListener('click', runStep);
  el('resetbtn').addEventListener('click', resetAll);
  el('inspect-toggle').addEventListener('click', toggleInspect);
  el('inspect-close').addEventListener('click', closeInspect);
  el('about-btn').addEventListener('click', function () { el('inspect-focus').innerHTML = ABOUT_HTML; openInspect(); });
  el('backend-mock').addEventListener('click', function () { setBackend('mock'); });
  el('backend-live').addEventListener('click', function () { setBackend('hapi'); });
  el('backend-local').addEventListener('click', function () { setBackend('local'); });
  el('local-base').addEventListener('change', function () { syncLocalBase(); if (isLocal()) resetAll(); });

  reflectBackend();
  refreshControls();
})();
