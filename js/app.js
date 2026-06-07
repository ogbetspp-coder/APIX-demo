/*
 * UI controller — the APIX Exchange Console.
 *
 * This is operational software, not slideware: a three-column console
 * (Applicant | live Exchange | Authority) over a Task state machine, with a
 * full-width state bar (live Task resource + Provenance audit). No story
 * stepper, no centered hero beats — every operation is a REAL engine call and
 * the centerpiece is the live FHIR request/response stream.
 *
 * The FHIR R5 engine (APIX.store / client / pqi / terminology) is UNCHANGED —
 * this file only renders it and drives the workflow:
 *   store.connect() / submit() / subscribe() / updateTask(effect)   (all async)
 *   store.bus 'task' | 'notification' | 'provenance'                 (events)
 *   APIX.client.bus 'io'  { request, response }                      (the wire)
 *
 * The Exchange timeline (CENTER column) is fed directly by the real 'io' stream,
 * interleaved with notification/status markers; each row carries a plain-English
 * annotation so a non-developer can follow what each operation does. The exact
 * updateTask effect payloads, the BIZ_GLOSS plain-language status map, the
 * Provenance/audit rendering, the JSON rendering via APIX.highlight, the backend
 * toggle, and the About/maturity content are all preserved from the prior
 * controller.
 */
(function () {
  var store = APIX.store;

  /* ============================ STATE ==================================== */
  // The case state — drives which actions each party may take.
  // idle → submitted → received → validation-successful → under-assessment
  //      → clock-stop → clock-restart → approved | rejected
  var state = 'idle';
  var inFlight = false;        // a handler is awaiting (guards double-clicks)
  var batchKey = 'good';       // 'good' | 'bad' — the screened batch
  var batchScreened = false;   // the conformance screen has been run at least once
  var specOpen = false;        // FDA "Open specification" toggled
  var infoAsked = false;       // an Information Request round was opened
  var answered = false;        // the applicant responded to the Information Request
  var decided = null;          // 'approve' | 'reject'
  var worklistOpen = false;    // the FDA worklist row is expanded
  var sigVerify = null;        // WS1: null = not verified | true = valid | false = invalid

  var reached = {};            // status code -> Date (for elapsed)
  var lastNotif = null;        // most recent notification bundle
  var inbox = [];              // applicant inbox messages (from notifications)
  var ioEntries = [];          // captured { request, response } interactions
  var auditEntries = [];       // FHIR Provenance audit records

  function el(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function now() { return new Date(); }
  function ts(d) { d = d || now(); return d.toTimeString().slice(0, 8); }

  function batchLabel() { return (APIX.pqi.batches[batchKey] || {}).label || batchKey; }
  function waterCheck() {
    return APIX.pqi.validate(batchKey).filter(function (r) { return /Water/.test(r.test); })[0];
  }

  /* The shared regulatory case number the engine stamps on submit (real). */
  function caseNo() {
    try {
      var id = (store.task.identifier || []).filter(function (i) { return i.system === APIX.SYS.procedureSystem; })[0];
      return id ? id.value : '215123/S-005';
    } catch (e) { return '215123/S-005'; }
  }

  /* Plain-language gloss of each businessStatus (the exec-legibility layer). */
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
  function gloss(code) { return BIZ_GLOSS[code] || ''; }

  /* The current case status in plain words (for the applicant panel). */
  function caseStatusText() {
    if (state === 'idle') return 'Not yet submitted';
    var t = store.task;
    var biz = (t && t.businessStatus && t.businessStatus.coding && t.businessStatus.coding[0])
      ? t.businessStatus.coding[0].code : state;
    return gloss(biz) || biz;
  }

  /* =================== EXCHANGE TIMELINE (the star) ===================== */
  /* Fed by the real APIX.client.bus 'io' stream. Each 'io' detail is a genuine
   * FHIR HTTP exchange; we render it as a row and annotate it in plain English.
   * Status/notification markers are interleaved as the workflow advances. */

  // Plain-English annotation for an 'io' interaction, derived from its method,
  // url and label so the row is legible to a non-developer.
  function ioAnnotation(e) {
    var req = e.request || {}, url = req.url || '', label = e.label || '';
    var m = req.method || '';
    if (/oauth2\/token/.test(url)) return 'SynthPharma authenticates to the gateway (SMART Backend Services token).';
    if (/\$validate/.test(url)) return 'Automated conformance check — FHIR $validate on the payload.';
    if (/\$translate/.test(url)) return 'Local lab code mapped to the PQI standard term (ConceptMap $translate).';
    if (/^WS$/.test(m)) return 'Real-time push channel (WebSocket) — ' + (req.body ? 'bind' : 'event') + '.';
    if (/Notification/.test(label)) return 'FDA pushes a real-time status update to SynthPharma.';
    if (m === 'POST' && /\/Binary/.test(url)) return 'The structured specification is streamed as a Binary.';
    if (m === 'POST' && /\/DocumentReference/.test(url)) return 'A DocumentReference describes the submitted specification.';
    if (m === 'POST' && /\/Subscription/.test(url)) return 'SynthPharma subscribes to real-time status updates for this case.';
    if (m === 'POST' && /\/Organization/.test(url)) return 'The applicant organisation is registered.';
    if (m === 'POST' && /\/Endpoint/.test(url)) return 'The notification webhook (Endpoint) is registered.';
    if (m === 'POST' && /\/Provenance/.test(url)) return 'An audit record (Provenance) is written — who, what, when, why.';
    if (m === 'POST' && /\/Task/.test(url)) return 'SynthPharma submits the supplement as structured data.';
    if (m === 'PUT' && /\/Task/.test(url)) return taskPutAnnotation(e);
    if (m === 'GET' && /\/Task/.test(url)) return 'FDA reads back the Task — the shared, live record of this case.';
    return label || (m + ' ' + url);
  }

  // A Task PUT carries a businessStatus transition; annotate it from the status.
  function taskPutAnnotation(e) {
    var body = (e.request && e.request.body) || {};
    var biz = (body.businessStatus && body.businessStatus.coding && body.businessStatus.coding[0])
      ? body.businessStatus.coding[0].code : '';
    var map = {
      'received': 'FDA acknowledges receipt — the review record is updated.',
      'validation-successful': 'Automated conformance check passed — the supplement is filed for review.',
      'under-assessment': 'FDA opens the structured specification for assessment.',
      'clock-stop': 'Information request issued — the review clock stops.',
      'clock-restart': 'SynthPharma responds — the review clock restarts.',
      'approved': 'FDA approves the supplement — the tightened limit takes effect.',
      'rejected': 'FDA issues a Complete Response Letter — not approved.'
    };
    return map[biz] || 'FDA advances the Task state.';
  }

  // The resource type/id touched by an interaction (for the row's mono chip).
  function ioResourceTag(e) {
    var url = (e.request && e.request.url) || '';
    var body = (e.response && e.response.body) || (e.request && e.request.body) || {};
    var m = url.replace(/^\//, '').split('?')[0];               // e.g. "Task/abc" or "Task/$validate"
    if (body && body.resourceType && body.id) return body.resourceType + '/' + body.id;
    if (/\$/.test(m)) return m;
    return m;
  }

  // The direction arrow: who is the actor of this interaction.
  // Submissions / responses / the applicant's reads flow → to FDA; FDA outputs
  // and notifications flow ← back to the applicant.
  function ioDirection(e) {
    var req = e.request || {}, url = req.url || '', label = e.label || '', m = req.method || '';
    if (/Notification/.test(label)) return 'in';                 // push to applicant
    if (m === 'PUT' && /\/Task/.test(url)) {                     // FDA advancing the case
      var body = req.body || {};
      var biz = (body.businessStatus && body.businessStatus.coding && body.businessStatus.coding[0])
        ? body.businessStatus.coding[0].code : '';
      if (biz === 'clock-restart') return 'out';                // applicant response → FDA
      return 'in';                                              // FDA acts → applicant sees it
    }
    if (m === 'POST' && /Provenance/.test(url)) return 'in';
    return 'out';                                                // applicant → FDA (default)
  }

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

  function renderExchangeRow(e) {
    var st = e.response || {}, req = e.request || {};
    var cls = ioStatusClass(st.status);
    var dir = ioDirection(e);
    var arrow = dir === 'in' ? '←' : '→';
    var to = dir === 'in' ? 'to SynthPharma' : 'to FDA';
    return '<div class="xrow xrow-' + dir + '" data-io="' + e.id + '">' +
      '<button class="xrow-sum">' +
        '<span class="xrow-time">' + esc(ts(e.ts)) + '</span>' +
        '<span class="xrow-dir" title="' + esc(to) + '">' + arrow + '</span>' +
        '<span class="xrow-method io-method">' + esc(req.method || '') + '</span>' +
        '<span class="xrow-path">' + esc(req.url || '') + '</span>' +
        '<span class="xrow-status io-' + cls + '">' + esc(String(st.status || '')) + '</span>' +
        '<span class="xrow-res"><code>' + esc(ioResourceTag(e)) + '</code></span>' +
        '<span class="xrow-note">' + esc(ioAnnotation(e)) + '</span>' +
      '</button>' +
      '<div class="xrow-detail" hidden>' +
        '<div class="io-sec">Request</div>' +
        '<div class="io-line"><span class="io-k">' + esc(req.method || '') + '</span> ' + esc(req.url || '') + '</div>' +
        ioHeaderRows(req.headers) + ioBody(req.body) +
        '<div class="io-sec">Response</div>' +
        '<div class="io-line"><span class="io-k">' + esc(String(st.status || '')) + '</span> ' + esc(st.statusText || '') + '</div>' +
        ioHeaderRows(st.headers) + ioBody(st.body) +
      '</div>' +
    '</div>';
  }

  function addIo(detail) {
    ioEntries.push(detail);
    el('exch-count').textContent = ioEntries.length;
    var log = el('exch-log');
    var emp = log.querySelector('.empty');
    if (emp) emp.remove();
    var wrap = document.createElement('div');
    wrap.innerHTML = renderExchangeRow(detail);
    var rowEl = wrap.firstChild;
    log.appendChild(rowEl);
    log.scrollTop = log.scrollHeight;
  }

  /* ===================== APPLICANT PANEL (LEFT) ======================== */
  function renderApplicant() {
    el('applicant-status').textContent = caseStatusText();
    el('applicant-status').className = 'cs-value cs-' + (state === 'idle' ? 'idle' : 'active');
    renderInbox();
    renderApplicantActions();
  }

  function renderInbox() {
    el('inbox-count').textContent = inbox.length;
    var host = el('inbox');
    if (!inbox.length) { host.innerHTML = '<div class="empty">No messages from FDA yet.</div>'; return; }
    host.innerHTML = inbox.map(function (m) {
      return '<div class="inbox-msg' + (m.alert ? ' inbox-alert' : '') + '">' +
        '<div class="inbox-meta"><span class="inbox-from">FDA</span>' +
          '<span class="inbox-time">' + esc(ts(m.time)) + '</span></div>' +
        '<div class="inbox-subj">' + esc(m.subject) + '</div>' +
        (m.body ? '<div class="inbox-body">' + esc(m.body) + '</div>' : '') +
        (m.bundle ? '<button class="link-btn" data-view-notif="1">view notification { }</button>' : '') +
      '</div>';
    }).join('');
  }

  // Only the applicant actions valid in the current state are enabled; the
  // suggested next action is subtly highlighted.
  function renderApplicantActions() {
    var rows = [];
    var canSubmit = state === 'idle';
    rows.push(actionBtn('app-submit', 'Submit supplement', canSubmit, canSubmit,
      'connect → submit → subscribe (real FHIR POST chain)'));
    var canRespond = state === 'clock-stop' && !answered;
    rows.push(actionBtn('app-respond', 'Respond to questions', canRespond, canRespond,
      'PUT Task → clock-restart (response-to-questions)'));
    el('applicant-actions').innerHTML = rows.join('');
  }

  /* ===================== AUTHORITY PANEL (RIGHT) ======================= */
  function renderAuthority() {
    renderWorklist();
    renderAuthorityDetail();
    renderAuthorityActions();
  }

  function renderWorklist() {
    var t = store.task;
    var host = el('worklist');
    if (!t || state === 'idle') {
      el('worklist-count').textContent = '0';
      host.innerHTML = '<div class="empty">No submissions in queue.</div>';
      el('authority-detail').hidden = true;
      return;
    }
    el('worklist-count').textContent = '1';
    var biz = (t.businessStatus && t.businessStatus.coding && t.businessStatus.coding[0]) ? t.businessStatus.coding[0] : {};
    var lu = (t.meta && t.meta.lastUpdated) ? new Date(t.meta.lastUpdated) : now();
    host.innerHTML =
      '<button class="wl-row' + (worklistOpen ? ' wl-open' : '') + '" data-wl="1">' +
        '<div class="wl-row-top">' +
          '<code class="wl-case">' + esc(caseNo()) + '</code>' +
          '<span class="badge badge-biz">' + esc(biz.display || biz.code || '') + '</span>' +
        '</div>' +
        '<div class="wl-row-bot">' +
          '<span class="badge badge-status">' + esc(t.status) + '</span>' +
          '<span class="wl-lu">updated ' + esc(ts(lu)) + '</span>' +
        '</div>' +
      '</button>';
  }

  function renderAuthorityDetail() {
    var open = worklistOpen && store.task && state !== 'idle';
    el('authority-detail').hidden = !open;
    if (!open) return;
    var body = '';

    // Open specification — the human-readable structured finished-product spec.
    body += '<div class="ad-sec">' +
      '<button class="link-btn" data-act="spec">' + (specOpen ? 'Hide' : 'Open') + ' specification (3.2.P.5.1)</button>' +
      (specOpen ? '<div class="ad-spec">' + APIX.pqi.renderSpecHtml() + '</div>' : '') +
    '</div>';

    // Screen batch — choose representative vs out-of-spec; run the conformance check.
    body += '<div class="ad-sec">' +
      '<div class="ad-sec-head">Screen batch against the specification</div>' +
      '<div class="batch-pick" role="group" aria-label="Batch">' +
        '<button class="pick-opt' + (batchKey === 'good' ? ' on' : '') + '" data-batch="good">Representative</button>' +
        '<button class="pick-opt' + (batchKey === 'bad' ? ' on' : '') + '" data-batch="bad">Out-of-spec</button>' +
      '</div>' +
      (batchScreened ? batchResultHtml() : '<p class="ad-hint">Select a batch and screen it against the structured ObservationDefinitions.</p>') +
    '</div>';

    // Cryptographic integrity — verify the applicant's signature; tamper to break it.
    if (store.specSignature) {
      var verdict = (sigVerify === null)
        ? '<span class="sig-idle">— not verified yet —</span>'
        : (sigVerify
            ? '<span class="sig-ok">&#10003; VALID &middot; signed by SynthPharma &middot; content intact</span>'
            : '<span class="sig-bad">&#10007; INVALID &middot; content was altered after signing</span>');
      body += '<div class="ad-sec sig-sec">' +
        '<div class="ad-sec-head">Cryptographic integrity</div>' +
        '<p class="sig-meta">Specification sealed by SynthPharma &mdash; a detached <strong>RSA-PSS / SHA-256</strong> ' +
          'signature over the <strong>RFC 8785 (JCS)</strong> canonical Bundle. ' +
          '<button class="link-btn" data-act="sig-json">view signature { }</button> ' +
          '<span class="sig-demo">illustrative demo key</span></p>' +
        '<label class="sig-tamper"><input type="checkbox" id="sig-tamper-cb"' + (store.tampered ? ' checked' : '') + '>' +
          ' Tamper &mdash; alter the signed Water Content limit after signing</label>' +
        (store.tampered && store.tamperInfo
          ? '<p class="sig-altered">Altered: ' + esc(store.tamperInfo.field) + ' &middot; ' +
              esc(store.tamperInfo.from) + ' &rarr; ' + esc(store.tamperInfo.to) + '</p>' : '') +
        '<div class="sig-row">' +
          '<button class="act-btn act-next" id="sig-verify"><span class="act-label">Verify signature</span></button>' +
          '<div class="sig-verdict">' + verdict + '</div>' +
        '</div>' +
      '</div>';
    }

    el('authority-detail-body').innerHTML = body;
  }

  function batchResultHtml() {
    var rows = APIX.pqi.validate(batchKey);
    var anyFail = rows.some(function (r) { return !r.pass; });
    var body = rows.map(function (r) {
      return '<tr' + (r.pass ? '' : ' class="val-fail-row"') + '>' +
        '<td>' + esc(r.test) + '</td><td>' + esc(r.criterion) + '</td>' +
        '<td>' + esc(r.measured) + '</td>' +
        '<td class="' + (r.pass ? 'pass' : 'fail') + '">' + (r.pass ? 'PASS' : 'FAIL') + '</td></tr>';
    }).join('');
    var banner = anyFail
      ? '<div class="val-banner val-banner-fail">Non-conformance flagged — ' +
          esc(waterCheck().test) + ' drift detected</div>'
      : '<div class="val-banner val-banner-pass">Batch conforms — all limits met</div>';
    return '<div class="ad-batch-label">' + esc(batchLabel()) + '</div>' + banner +
      '<table class="val-table"><thead><tr><th>Test</th><th>Criterion</th><th>Measured</th><th>Result</th></tr></thead>' +
      '<tbody>' + body + '</tbody></table>';
  }

  // FDA regulatory actions, gated by state; the suggested next is highlighted.
  function renderAuthorityActions() {
    var rows = [];
    function reg(id, label, validIn, hint) {
      var ok = state === validIn;
      rows.push(actionBtn(id, label, ok, ok, hint));
    }
    reg('reg-ack', 'Acknowledge receipt', 'submitted', 'PUT Task → received');
    reg('reg-conformance', 'Run conformance check', 'received', 'PUT Task → validation-successful');
    reg('reg-screen', 'Screen batch (assess)', 'validation-successful', 'PUT Task → under-assessment');
    reg('reg-info', 'Raise Information Request', 'under-assessment', 'PUT Task → clock-stop');
    // Decision: valid once the applicant has responded (clock-restart). Allow re-deciding.
    var canDecide = state === 'clock-restart' || (decided && state === 'decided');
    rows.push(actionBtn('reg-approve', 'Approve', canDecide, canDecide && decided !== 'approve',
      'PUT Task → completed / approved'));
    rows.push(actionBtn('reg-reject', 'Issue Complete Response', canDecide, canDecide && decided !== 'reject',
      'PUT Task → completed / rejected'));
    el('authority-actions').innerHTML = rows.join('');
  }

  /* A console action button: disabled when invalid; "suggested next" gets accent. */
  function actionBtn(id, label, enabled, suggested, hint) {
    return '<button class="act-btn' + (suggested ? ' act-next' : '') + '" id="' + id + '"' +
      (enabled ? '' : ' disabled') + '>' +
      '<span class="act-label">' + esc(label) + '</span>' +
      '<span class="act-hint io-method-inline">' + esc(hint) + '</span>' +
    '</button>';
  }

  /* ======================== STATE BAR (BOTTOM) ========================= */
  function renderStateBar() {
    var t = store.task;
    var line = el('sb-task-line');
    if (!t || state === 'idle') {
      el('sb-task-summary').textContent = 'not created';
      el('sb-task-summary').hidden = false;
      el('sb-task-view').hidden = true;
      el('sb-task-json').hidden = true;
      line.querySelector('.sb-detail') && line.querySelector('.sb-detail').remove();
      return;
    }
    var v = (t.meta && t.meta.versionId) || '1';
    var biz = (t.businessStatus && t.businessStatus.coding && t.businessStatus.coding[0]) ? t.businessStatus.coding[0] : {};
    var lu = (t.meta && t.meta.lastUpdated) ? new Date(t.meta.lastUpdated) : now();
    el('sb-task-summary').hidden = true;
    var existing = line.querySelector('.sb-detail');
    var html =
      '<code class="sb-id">Task/' + esc(t.id) + '</code>' +
      '<span class="sb-ver">v' + esc(v) + '</span>' +
      '<span class="badge badge-status">' + esc(t.status) + '</span>' +
      '<span class="badge badge-biz">' + esc(biz.display || biz.code || '') + '</span>' +
      '<span class="sb-lu">lastUpdated ' + esc(ts(lu)) + '</span>';
    if (existing) existing.innerHTML = html;
    else {
      var d = document.createElement('span');
      d.className = 'sb-detail';
      d.innerHTML = html;
      el('sb-task-view').before(d);
    }
    el('sb-task-view').hidden = false;
    if (!el('sb-task-json').hidden) el('sb-task-json').innerHTML = APIX.highlight(t);
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
    var when = p.recorded ? ts(new Date(p.recorded)) : '';
    return '<tr><td class="aud-when">' + esc(when) + '</td>' +
      '<td>' + provWho(p) + '</td><td>' + provWhat(p) + '</td>' +
      '<td class="aud-why">' + esc(provWhy(p)) +
        ' <button class="link-btn" data-prov="' + esc(p.id) + '">view</button></td></tr>';
  }
  function renderAudit() {
    el('audit-count').textContent = auditEntries.length;
    var host = el('audit-wrap');
    if (!auditEntries.length) { host.innerHTML = '<div class="empty">No audit records yet.</div>'; return; }
    host.innerHTML =
      '<table class="grid audit-table"><thead><tr><th>When</th><th>Who</th><th>What</th><th>Why</th></tr></thead><tbody>' +
        auditEntries.map(renderAuditEntry).join('') + '</tbody></table>';
  }
  function addAudit(p) { auditEntries.push(p); renderAudit(); }

  /* ============================ RENDER ALL ============================== */
  function render() {
    el('case-no').textContent = (state === 'idle') ? '—' : caseNo();
    renderApplicant();
    renderAuthority();
    renderStateBar();
  }

  /* ============================ HANDLERS =============================== */
  // Each transition is a REAL engine call; the 'io'/'task'/'notification'/
  // 'provenance' events drive the timeline, panels, status chips and audit.

  async function doSubmit() {
    if (inFlight || state !== 'idle') return;
    inFlight = true;
    try {
      // Author the structured content (fires the real $translate calls), then
      // run the genuine connect → submit → subscribe chain.
      APIX.terminology.rows().forEach(function (r) {
        APIX.client.translate(r.source.system, r.source.code);
      });
      APIX.pqi.normalize();

      setConn('connecting', 'Connecting…');
      await store.connect();
      await store.submit();
      if (!reached['submitted']) reached['submitted'] = now();
      await store.subscribe();
      state = 'submitted';
      worklistOpen = true;
      setConn('connected', isLive() ? 'Connected · ' + APIX.config.activeBase() : 'Connected · mock');
    } catch (e) {
      setConn('error', 'Connection error');
    }
    inFlight = false;
    render();
  }

  async function advance(effect, nextState) {
    if (inFlight) return;
    inFlight = true;
    try {
      await store.updateTask(effect);
      state = nextState;
    } catch (e) { /* surface stays usable */ }
    inFlight = false;
    render();
  }

  // FDA actions — verbatim effect payloads from the prior controller.
  function doAcknowledge() {
    if (state !== 'submitted') return;
    return advance({ type: 'updateTask', status: 'received', businessStatus: 'received', addProcedureNo: true, addOutputs: ['ack'] }, 'received');
  }
  function doConformance() {
    if (state !== 'received') return;
    return advance({ type: 'updateTask', status: 'accepted', businessStatus: 'validation-successful', addOutputs: ['validation'], flexibility: true }, 'validation-successful');
  }
  function doScreenStart() {
    if (state !== 'validation-successful') return;
    return advance({ type: 'updateTask', status: 'in-progress', businessStatus: 'under-assessment' }, 'under-assessment');
  }
  function doInfoRequest() {
    if (state !== 'under-assessment' || infoAsked) return;
    infoAsked = true;
    return advance({ type: 'updateTask', status: 'on-hold', businessStatus: 'clock-stop', taskCode: 'information-request' }, 'clock-stop');
  }
  function doRespond() {
    if (state !== 'clock-stop' || answered) return;
    answered = true;
    return advance({ type: 'updateTask', status: 'in-progress', businessStatus: 'clock-restart', taskCode: 'response-to-questions' }, 'clock-restart');
  }
  async function doDecision(kind) {
    if (inFlight) return;
    var canDecide = state === 'clock-restart' || state === 'decided';
    if (!canDecide || kind === decided) return;
    inFlight = true;
    try {
      if (kind === 'approve') {
        await store.updateTask({ type: 'updateTask', status: 'completed', businessStatus: 'approved', taskCode: 'approval', addOutputs: ['approval', 'assessment'] });
        decided = 'approve';
      } else {
        await store.updateTask({ type: 'updateTask', status: 'completed', businessStatus: 'rejected', taskCode: 'rejection', addOutputs: ['rejection'], statusReason: 'Complete Response: the tested batch did not meet the proposed limit.' });
        decided = 'reject';
      }
      state = 'decided';
    } catch (e) { /* surface stays usable */ }
    inFlight = false;
    render();
  }

  // Batch / spec controls — local, no engine state change.
  function doScreenBatch(key) {
    batchKey = key;
    batchScreened = true;
    renderAuthorityDetail();
  }
  function doToggleSpec() { specOpen = !specOpen; renderAuthorityDetail(); }

  // WS1 — verify the spec signature against the (possibly tampered) Bundle.
  async function doVerify() {
    if (inFlight) return;
    sigVerify = await store.verifySpec();
    renderAuthorityDetail();
  }
  function viewSignature() {
    var prov = (store.provenance || []).filter(function (p) { return p.signature; })[0];
    openModal('Provenance — signed specification (FHIR Signature)',
      '<pre class="modal-json">' + APIX.highlight(prov || { resourceType: 'Provenance', signature: [store.specSignature] }) + '</pre>');
  }

  /* ============================ MODAL ================================== */
  function openModal(title, html) {
    el('modal-title').textContent = title;
    el('modal-content').innerHTML = html;
    el('modal').hidden = false;
  }
  function closeModal() { el('modal').hidden = true; }

  function viewNotif() {
    openModal('Subscription notification Bundle',
      '<pre class="modal-json">' + APIX.highlight(lastNotif || { resourceType: 'Bundle', type: 'subscription-notification' }) + '</pre>');
  }
  function viewProvenance(id) {
    var pr = store.get('Provenance/' + id);
    if (pr) openModal('Provenance — audit record', '<pre class="modal-json">' + APIX.highlight(pr) + '</pre>');
  }

  /* ============================ STORE EVENTS =========================== */
  store.bus.addEventListener('task', function (ev) {
    if (ev.detail.firstTime && !reached['submitted']) reached['submitted'] = now();
    renderWorklist(); renderStateBar();
  });
  store.bus.addEventListener('notification', function (ev) {
    lastNotif = ev.detail.bundle;
    var code = ev.detail.businessStatus;
    reached[code] = now();
    // Frame each push as a message landing in the applicant's inbox. The gloss
    // reads "<short title> — <explanation>"; split it into subject + body.
    var g = gloss(code) || ('Status update — ' + code);
    var dash = g.indexOf(' — ');
    var subject = dash > 0 ? g.slice(0, dash) : g;
    var body = dash > 0 ? g.slice(dash + 3) : '';
    var alert = code === 'clock-stop';
    if (code === 'clock-stop') body = APIX.RSI.question;        // the actual List of Questions
    inbox.unshift({ time: now(), subject: subject, body: body, bundle: ev.detail.bundle, alert: alert });
    renderInbox(); el('inbox-count').textContent = inbox.length;
    renderApplicant();
  });
  store.bus.addEventListener('provenance', function (ev) { addAudit(ev.detail.provenance); });
  APIX.client.bus.addEventListener('io', function (ev) { addIo(ev.detail); });

  /* ============================ RESET ================================== */
  function resetAll() {
    state = 'idle'; inFlight = false;
    batchKey = 'good'; batchScreened = false; specOpen = false;
    infoAsked = false; answered = false; decided = null; worklistOpen = false; sigVerify = null;
    reached = {}; lastNotif = null; inbox = []; ioEntries = []; auditEntries = [];
    store.reset();
    el('exch-log').innerHTML = '<div class="empty">No exchanges yet. Submit the supplement to begin.</div>';
    el('exch-count').textContent = '0';
    renderAudit();
    closeModal();
    setConn('idle', isLive() ? 'Not connected · ' + APIX.config.activeBase() : 'Not connected · mock');
    render();
  }

  /* ===================== CONNECTION STATUS ============================= */
  function setConn(kind, label) {
    el('conn-dot').className = 'cb-dot cb-dot-' + kind;
    el('conn-label').textContent = label;
  }

  /* ===================== BACKEND TOGGLE (mock/local/live) ============== */
  function isLive() { return APIX.config && APIX.config.backend === 'hapi'; }
  function isLocal() { return APIX.config && APIX.config.backend === 'local'; }
  function reflectBackend() {
    var live = isLive(), local = isLocal();
    el('backend-toggle').classList.toggle('live', live);
    el('backend-toggle').classList.toggle('local', local);
    el('backend-mock').classList.toggle('on', !live && !local);
    el('backend-live').classList.toggle('on', live);
    el('backend-local').classList.toggle('on', local);
    el('local-base').hidden = !local;
    var sb = el('server-base');
    if (live) { sb.textContent = 'hapi.fhir.org/baseR5'; sb.className = 'server-base sb-live'; }
    else if (local) { sb.textContent = APIX.config.localBase; sb.className = 'server-base sb-local'; }
    else { sb.textContent = 'in-memory mock server'; sb.className = 'server-base'; }
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
    '<p class="muted">Mock mode is the default: offline, deterministic, instant. ' +
    '<a href="https://build.fhir.org/ig/HL7/APIX---API-Exchange-for-Medicinal-Products/" target="_blank" rel="noopener">APIX IG ↗</a> · ' +
    '<a href="https://build.fhir.org/ig/HL7/FHIR-us-pq-cmc-fda/" target="_blank" rel="noopener">PQ-CMC FHIR IG ↗</a></p>';

  /* ============================ WIRING ================================= */
  document.addEventListener('click', function (ev) {
    // Exchange / IO row expand.
    var xs = ev.target.closest('.xrow-sum');
    if (xs) { var det = xs.parentNode.querySelector('.xrow-detail'); if (det) det.hidden = !det.hidden; return; }

    // Worklist row toggle.
    if (ev.target.closest('[data-wl]')) { worklistOpen = !worklistOpen; renderAuthority(); return; }

    // Batch picker / spec toggle (authority detail).
    var bp = ev.target.closest('[data-batch]'); if (bp) { doScreenBatch(bp.getAttribute('data-batch')); return; }

    // WS1 — signature tamper toggle + verify.
    if (ev.target.id === 'sig-tamper-cb') { store.setTampered(ev.target.checked); sigVerify = null; renderAuthorityDetail(); return; }
    if (ev.target.closest('#sig-verify')) { doVerify(); return; }

    // Notification / provenance viewers.
    if (ev.target.closest('[data-view-notif]')) { viewNotif(); return; }
    var pv = ev.target.closest('[data-prov]'); if (pv) { viewProvenance(pv.getAttribute('data-prov')); return; }

    // Task JSON expand in the state bar.
    if (ev.target.closest('#sb-task-view')) {
      var j = el('sb-task-json');
      if (j.hidden) { j.innerHTML = APIX.highlight(store.task || {}); j.hidden = false; el('sb-task-view').textContent = 'hide JSON'; }
      else { j.hidden = true; el('sb-task-view').textContent = 'view JSON'; }
      return;
    }

    // Generic act buttons (spec toggle lives here too).
    var a = ev.target.closest('[data-act]');
    if (a) { var av = a.getAttribute('data-act'); if (av === 'spec') doToggleSpec(); else if (av === 'sig-json') viewSignature(); return; }

    // Action buttons by id.
    var id = ev.target.closest('button') && ev.target.closest('button').id;
    if (id === 'app-submit') return doSubmit();
    if (id === 'app-respond') return doRespond();
    if (id === 'reg-ack') return doAcknowledge();
    if (id === 'reg-conformance') return doConformance();
    if (id === 'reg-screen') return doScreenStart();
    if (id === 'reg-info') return doInfoRequest();
    if (id === 'reg-approve') return doDecision('approve');
    if (id === 'reg-reject') return doDecision('reject');
  });

  el('resetbtn').addEventListener('click', resetAll);
  el('about-btn').addEventListener('click', function () { openModal('About / FDA context / maturity', ABOUT_HTML); });
  el('modal-close').addEventListener('click', closeModal);
  el('modal').addEventListener('click', function (ev) { if (ev.target === el('modal')) closeModal(); });
  el('sb-audit-toggle').addEventListener('click', function () {
    var w = el('audit-wrap');
    w.hidden = !w.hidden;
    el('sb-audit-chev').textContent = w.hidden ? '▸' : '▾';
  });
  el('backend-mock').addEventListener('click', function () { setBackend('mock'); });
  el('backend-live').addEventListener('click', function () { setBackend('hapi'); });
  el('backend-local').addEventListener('click', function () { setBackend('local'); });
  el('local-base').addEventListener('change', function () { syncLocalBase(); if (isLocal()) resetAll(); });

  reflectBackend();
  setConn('idle', 'Not connected · mock');
  renderAudit();
  render();
})();
