/*
 * UI controller — two role panes, each driving its OWN workflow (the ping-pong),
 * a shared status spine, and one Inspect slide-over for all FHIR / API detail.
 *
 * The FHIR data layer (APIX.store / APIX.client / APIX.pqi / APIX.terminology)
 * is unchanged; this file only renders it. Layout:
 *   - STATUS SPINE  : Draft → Submitted → Received → Validated → Assessing → Decision
 *   - INDUSTRY pane : workflow ① Author ② Submit (· Send answers) + spec/track
 *   - HA pane       : workflow ① Assess ② Decision + received/review
 *   - FOOTER        : tiny progress + Reset (no global driver)
 *   - INSPECT       : focus resource/request + running 'io' call list
 *
 * Per-side workflows (the driver): each pane shows its steps as a short ordered
 * list. The one actionable step on the side whose TURN it is renders as a single
 * live primary button; completed steps show a check; the waiting side's next
 * step shows a muted "Waiting for …" state. At most one live action on screen.
 * Clicking a side's button runs its handler, advances the single FHIR Task, and
 * PASSES THE TURN: a brief "Subscription notification →" cue crosses between the
 * panes and lights up the other side's next button.
 *
 * Realism anchor: docs/REGULATORY-FLOW.md. THREE distinct "validations":
 *   1. Conformance check — FHIR $validate → OperationOutcome (AUTOMATIC, in-flight).
 *   2. Administrative validation — completeness/eligibility (AUTOMATIC/quick) →
 *      validation-successful.
 *   3. Scientific assessment — the assessor's HUMAN review → under-assessment
 *      (this is where the structured acceptance-criteria FAIL/PASS belongs).
 *
 * Flow: Author → Submit → [AUTO chain: $validate (conformance ✓) · received ·
 *   validation-successful] → Regulator ASSESS (human) → Decide. There is NO
 *   manual "Validate" regulator button. Decision branch: Request for
 *   Supplementary Information (RSI) → clock-stop, turn → Industry "Send answers"
 *   → clock-restart, turn → Regulator Decide. Approve / Reject → terminal Summary.
 */
(function () {
  var store = APIX.store;

  /* ---- Per-side workflow state machine ---------------------------------- *
   * `turn`  = the side whose action is live ('ind' | 'ha' | null at terminal)
   * `phase` = the live step key (author | submit | assess | decision |
   *           answers | done)
   * `done`  = step key -> true once completed (renders a check)             */
  var turn = 'ind';
  var phase = 'author';
  var done = {};
  var infoAsked = false;       // a Request-information round has been issued

  /* The two per-side workflows. `key` is the live-step key; `actor` drives the
   * pane emphasis; `button` is the clean business verb shown when live.
   * `info`-only steps (Send answers) are revealed conditionally.            */
  var IND_FLOW = [
    { key: 'author', label: 'Author specification', button: 'Author specification' },
    { key: 'submit', label: 'Submit application', button: 'Submit application' },
    { key: 'answers', label: 'Send answers', button: 'Send answers', conditional: true }
  ];
  var HA_FLOW = [
    { key: 'assess', label: 'Assess', button: 'Assess' },
    { key: 'decision', label: 'Decision', button: null }   // renders the 3 decision buttons
  ];

  var reached = {};          // businessStatus code -> Date reached (spine + cycle time)
  var lastNotif = null;      // most recent notification Bundle (Inspect focus)
  var inFlight = false;      // a step handler is awaiting (live latency guard)

  var ioEntries = [];        // captured { request, response } interactions
  var auditEntries = [];     // FHIR Provenance audit log (21 CFR Part 11 / ALCOA)
  var batchKey = 'good';     // regulator's selected tested batch (good | bad)
  var specMode = 'doc';      // consolidated spec view (doc | fhir)

  function el(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function bytes(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.round(n / 1e3) + ' KB'; }
  function show(id) { el(id).hidden = false; }
  function hide(id) { el(id).hidden = true; }

  /* ============================ STATUS SPINE =============================== */
  /* Draft/Author → businessStatusFlow → Decision. The whole exchange is just
     this advancing: current navy, reached get a check + timestamp, future muted. */
  /* One clean linear pipeline: Draft → Submitted → Received → Validated →
     Assessing → Decision. The terminal 'approved' milestone is folded into the
     single 'Decision' node (reached on approve OR reject) so there is never a
     dangling "Approved" node on a rejection. */
  var SPINE = [{ code: 'draft', label: 'Draft' }]
    .concat(APIX.businessStatusFlow
      .filter(function (m) { return m.code !== 'approved'; })
      .map(function (m) { return { code: m.code, label: m.label }; }))
    .concat([{ code: 'decision', label: 'Decision' }]);

  /* Resolve which spine node is "current" from the live phase. */
  function spineCurrent() {
    switch (phase) {
      case 'author': case 'submit': return 'draft';
      case 'assess': return 'under-assessment';
      case 'decision': case 'answers': return 'decision';
      default: return 'decision';
    }
  }

  function renderSpine() {
    var cur = spineCurrent();
    var html = SPINE.map(function (n) {
      var doneNode = (n.code === 'draft')
        ? (!!done.submit || !!reached['submitted'])       // Draft is "done" once we've submitted
        : (n.code === 'decision')
          ? (!!reached['approved'] || !!reached['rejected'])
          : !!reached[n.code];
      var isCur = (n.code === cur) && !doneNode;
      var ts = (n.code !== 'draft' && n.code !== 'decision' && reached[n.code])
        ? reached[n.code].toLocaleTimeString() : '';
      var cls = 'sp-node' + (doneNode ? ' done' : '') + (isCur ? ' cur' : '');
      return '<div class="' + cls + '">' +
        '<span class="sp-mark"></span>' +
        '<span class="sp-lbl">' + esc(n.label) + '</span>' +
        (ts ? '<span class="sp-ts">' + esc(ts) + '</span>' : '') +
        '</div>';
    }).join('<span class="sp-sep"></span>');
    el('spine').innerHTML = html;
  }

  /* ======================= PANE EMPHASIS (calm) =========================== */
  function setActivePane(side) {
    el('pane-ind').classList.toggle('is-active', side === 'ind');
    el('pane-ha').classList.toggle('is-active', side === 'ha');
  }

  /* ============================ FLOW RENDERING ============================ */
  /* Render one pane's ordered workflow list. At most one step is "live" — the
     next-undone step on the side whose TURN it is. Completed steps show a check;
     the waiting side's next step shows a muted "Waiting for …" state. */
  function flowItemHtml(step, state, side) {
    var mark = state === 'done' ? '<span class="fl-mark fl-done"></span>'
      : state === 'live' ? '<span class="fl-mark fl-live"></span>'
      : '<span class="fl-mark"></span>';
    var body;
    if (state === 'live') {
      if (step.key === 'decision') {
        body = '<div class="fl-label">' + esc(step.label) + '</div>' +
          '<div class="decision-btns" id="decision-btns">' +
            '<button class="dec-btn dec-approve" data-decision="approve">Approve</button>' +
            '<button class="dec-btn dec-info" data-decision="info"' + (infoAsked ? ' disabled' : '') + ' title="Request for Supplementary Information (RSI)">Request information (RSI)</button>' +
            '<button class="dec-btn dec-reject" data-decision="reject">Reject</button>' +
          '</div>';
      } else {
        body = '<button class="btn-primary fl-action" data-flow="' + esc(step.key) + '">' + esc(step.button) + '</button>';
      }
    } else if (state === 'waiting') {
      var other = side === 'ind' ? 'the Regulator' : 'SynthPharma';
      body = '<div class="fl-label">' + esc(step.label) + '</div>' +
        '<div class="fl-wait">Waiting for ' + other + '</div>';
    } else {
      body = '<div class="fl-label">' + esc(step.label) + '</div>';
    }
    return '<li class="fl-item fl-' + state + '">' + mark + '<div class="fl-body">' + body + '</div></li>';
  }

  /* Compute each step's state for one side. The live step is rendered only when
     it is that side's TURN and no handler is in flight. */
  function renderFlow(side) {
    var flow = side === 'ind' ? IND_FLOW : HA_FLOW;
    var listEl = el(side === 'ind' ? 'ind-flow' : 'ha-flow');
    var isTurn = (turn === side) && !inFlight;
    var liveFound = false;
    var html = flow.map(function (step) {
      if (step.conditional && step.key === 'answers' && !infoAsked) return '';   // hidden until asked
      var state;
      if (done[step.key]) {
        state = 'done';
      } else if (!liveFound) {
        // first undone step on this side
        if (step.key === phase && isTurn) { state = 'live'; liveFound = true; }
        else if (step.key === phase && !isTurn) { state = 'waiting'; liveFound = true; }
        else { state = 'pending'; liveFound = true; }
      } else {
        state = 'pending';
      }
      return flowItemHtml(step, state, side);
    }).join('');
    listEl.innerHTML = html;
  }

  function refreshControls() {
    renderSpine();
    renderFlow('ind');
    renderFlow('ha');
    setActivePane(inFlight ? null : turn);
    var label = phase === 'done' ? 'Complete'
      : (turn === 'ind' ? 'SynthPharma' : 'Health Authority') + ' · ' +
        (phase.charAt(0).toUpperCase() + phase.slice(1));
    el('progress').textContent = label;
  }

  /* ===================== TURN HAND-OFF + CROSSING CUE ==================== */
  /* Pass the turn to the other side, with a brief, labeled "Subscription
     notification →" cue crossing between the panes. The receiving pane then
     briefly emphasizes (handled by the .recv pulse). */
  function crossNotification(toSide, label) {
    var x = el('xing');
    x.className = 'xing xing-' + toSide;
    x.innerHTML = '<span class="xing-tag">Subscription notification</span>' +
      '<span class="xing-arrow">→</span>' +
      '<span class="xing-dest">' + (toSide === 'ha' ? 'Regulator' : 'SynthPharma') + '</span>' +
      (label ? '<span class="xing-msg">' + esc(label) + '</span>' : '');
    x.hidden = false;
    // re-trigger the CSS animation
    void x.offsetWidth;
    x.classList.add('show');
    setTimeout(function () {
      x.classList.remove('show');
      x.hidden = true;
      var pane = el(toSide === 'ha' ? 'pane-ha' : 'pane-ind');
      pane.classList.add('recv');
      setTimeout(function () { pane.classList.remove('recv'); }, 900);
    }, 1500);
  }

  /* Advance the state machine to a new phase owned by `side`, marking `prevKey`
     done, then render. When `notifTo` is set, cross the notification cue. */
  function passTurn(prevKey, nextPhase, nextTurn, notifTo, notifLabel) {
    if (prevKey) done[prevKey] = true;
    phase = nextPhase;
    turn = nextTurn;
    if (notifTo) crossNotification(notifTo, notifLabel);
    refreshControls();
  }

  /* ============================ FLOW DISPATCH ============================ */
  /* A side's live button was clicked. Run its handler (async; live mode does
     real network I/O), guard against a fast double-click, then pass the turn. */
  async function runFlow(key) {
    if (inFlight || done[key]) return;
    if (key !== phase) return;
    inFlight = true;
    refreshControls();   // hides the live button while awaiting
    try {
      if (key === 'author') {
        handleAuthor();
        passTurn('author', 'submit', 'ind');           // same side, no notification
      } else if (key === 'submit') {
        await handleSubmit();
        // Submit → Task created, then the AUTOMATIC transport/server chain ran:
        // $validate (conformance ✓) → received → validation-successful. The
        // payload lands on the Regulator already conformant, received, and
        // administratively validated. The turn passes to the Regulator's human
        // Assess (the spine has already advanced through Validated).
        passTurn('submit', 'assess', 'ha', 'ha', 'Validated (auto)');
      } else if (key === 'assess') {
        await handleAssess();
        // Assess is the Regulator's own human action; the turn stays on the HA
        // side, advancing to its Decision (no cross-pane notification).
        passTurn('assess', 'decision', 'ha');
      } else if (key === 'answers') {
        await handleAnswers();
        // Clock restarts; the response notification crosses back to the
        // Regulator's Decision.
        passTurn('answers', 'decision', 'ha', 'ha', 'Clock Restart');
      }
    } catch (e) {
      flashError('Step failed');
    } finally {
      inFlight = false;
      refreshControls();
    }
  }

  /* ============================ INDUSTRY ① Author ======================== */
  /* Source systems, each given a sober origin color (from existing tokens) so a
     viewer sees which datum came from where as the spec is ASSEMBLED:
       LIMS = blue (--org-lims) · Stability = green (--org-stab) · Method = amber (--org-meth). */
  var SOURCES = [
    { key: 'lims',  cls: 'org-lims',  label: 'LIMS' },
    { key: 'stab',  cls: 'org-stab',  label: 'Stability System' },
    { key: 'meth',  cls: 'org-meth',  label: 'Method Repository' }
  ];

  /* Which source system each harmonized term arrives FROM (drives the per-row
     colored lane + staggered "lands from its source" animation). Test terms come
     off the LIMS QC export; shelf-life-defining tests are confirmed against the
     Stability System; unit shorthand is carried by the Method Repository. */
  var TERM_SOURCE = {
    'DESCR': 'lims', 'ID-HPLC': 'lims', 'POT': 'lims', 'DISSO': 'lims',
    'DEGR': 'stab', 'KF': 'stab', 'MICRO': 'lims',
    'PCT_WW': 'meth', 'PCT_LC': 'meth'
  };
  function srcOf(code) { return TERM_SOURCE[code] || 'lims'; }
  function srcCls(key) {
    for (var i = 0; i < SOURCES.length; i++) if (SOURCES[i].key === key) return SOURCES[i].cls;
    return 'org-lims';
  }

  /* Author — produce ONE structured artifact: the PQI Bundle. Each local term
     fires a real FHIR ConceptMap / $translate (visible in Inspect → API calls);
     the full local→standard mapping is one click away ("view mappings"). No
     on-stage wall of tables — the colored spec + the change tell the story. */
  function handleAuthor() {
    APIX.terminology.rows().forEach(function (r, n) {
      setTimeout(function () { APIX.client.translate(r.source.system, r.source.code); }, 60 * n + 40);
    });
    APIX.pqi.normalize();
    show('ind-spec');
    renderConsolidated();
  }

  /* The local→PQI ConceptMap mapping, on demand in the Inspect slide-over: every
     row is a real $translate (Source · local code → PQI standard term), colored
     by origin system. Keeps the construction provable without cluttering stage. */
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

  /* Consolidated spec — compact table with the one changed row highlighted, plus
     an inline Document⇄FHIR toggle. In Document view each datum is tinted by its
     origin (Release ← LIMS, End-of-shelf-life ← Stability, Method ← Method repo)
     via a subtle colored left-border + dot, and revealed with a gentle stagger. */
  function renderConsolidated() {
    el('spec-seg').querySelector('[data-mode="doc"]').classList.toggle('on', specMode === 'doc');
    el('spec-seg').querySelector('[data-mode="fhir"]').classList.toggle('on', specMode === 'fhir');
    var body;
    if (specMode === 'fhir') {
      body = '<pre class="modal-json cons-json">' + APIX.highlight(APIX.pqi.bundle || APIX.pqi.normalize()) + '</pre>';
      el('consolidated').innerHTML = body;
      return;
    }
    var rows = APIX.pqi.specRows().map(function (r) {
      var shelf = r.changed
        ? '<span class="diff-new">' + esc(r.shelfLife) + ' w/w</span>'
        : esc(r.shelfLife);
      return '<tr' + (r.changed ? ' class="row-changed"' : '') + '>' +
        '<td>' + esc(r.test) + '</td>' +
        '<td class="org-cell org-meth">' + esc(r.method) + '</td>' +
        '<td class="org-cell org-lims">' + esc(r.release) + '</td>' +
        '<td class="org-cell org-stab">' + shelf + '</td></tr>';
    }).join('');
    body =
      '<p class="cons-change"><span class="chg-tag">Change</span> <strong>' + esc(APIX.pqi.CHANGE.label) + '</strong> ' +
        '<span class="diff-old">' + esc(APIX.pqi.CHANGE.before) + '</span> → <span class="diff-new">' + esc(APIX.pqi.CHANGE.after) + '</span></p>' +
      '<table class="grid spec-table"><thead><tr><th>Test</th>' +
        '<th class="org-th org-meth">Method</th>' +
        '<th class="org-th org-lims">Release</th>' +
        '<th class="org-th org-stab">End of shelf life</th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table>' +
      '<div class="cons-legend">' +
        '<span class="src-chip org-lims"><span class="src-dot"></span>Release ← LIMS</span>' +
        '<span class="src-chip org-stab"><span class="src-dot"></span>End of shelf life ← Stability System</span>' +
        '<span class="src-chip org-meth"><span class="src-dot"></span>Method ← Method Repository</span>' +
      '</div>' +
      '<div class="cmap-line">Harmonized from 3 structured systems · FHIR <code>ConceptMap</code> · <code>$translate</code> ' +
        '<button class="link-btn" data-inspect="harmonize">view mappings</button></div>';
    el('consolidated').innerHTML = body;
    // gentle staggered assembly reveal
    var trs = el('consolidated').querySelectorAll('.spec-table tbody tr');
    [].forEach.call(trs, function (tr, n) {
      tr.classList.add('asm');
      setTimeout(function () { tr.classList.add('in'); }, 130 * n + 60);
    });
  }

  /* ============================ INDUSTRY ②/③ ============================= */
  /* The APIX transport made visible on-stage: the structured PQI Bundle is
     encoded as a Binary, described by a DocumentReference, carried by one Task.
     One click opens the full layered wrapper (with a real base64 decode). */
  function apixEnvelopeHtml() {
    return '<div class="apix-env">' +
      '<span class="env-lbl">APIX wrapper</span>' +
      '<span class="env-chip">Task</span><span class="env-arrow">▸</span>' +
      '<span class="env-chip">DocumentReference</span><span class="env-arrow">▸</span>' +
      '<span class="env-chip">Binary</span><span class="env-arrow">▸</span>' +
      '<span class="env-chip env-bundle">PQI Bundle</span>' +
      '<button class="link-btn" data-inspect="wrapper">open ↗</button>' +
    '</div>';
  }

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

  /* Submit — one action: connect (OAuth + register, silent — visible only in
     Inspect → API calls), create the single Binary + DocumentReference + Task,
     and subscribe for real-time status. The ONE payload lands on the HA pane
     automatically (auto-"received"). Merges the old connect/submit/subscribe. */
  async function handleSubmit() {
    await store.connect();
    await store.submit();
    var t = store.task;
    show('ind-pkg');
    el('pkg').innerHTML =
      '<div class="pkg-head">' + t.input.length + ' document ' +
        '<button class="link-btn" data-inspect="task">view Task</button>' + verifyLinkHtml() + '</div>' +
      apixEnvelopeHtml() +
      docsHtml(t.input);
    show('ind-track');
    feed('Submitted');

    await store.subscribe();
    if (!reached['submitted']) reached['submitted'] = new Date();

    // ---- AUTOMATIC transport/server chain (no human action) -----------------
    // Per docs/REGULATORY-FLOW.md, three things happen to the payload in-flight,
    // each surfaced on the feed with a brief visible delay so the spine advances
    // calmly. None of these is a button.
    //
    //  (a) Conformance check — the $validate OperationOutcome was already produced
    //      inside store.submit() (real HAPI $validate live; mock server returns an
    //      informational OperationOutcome). Surface a sober "Conformance ✓" tag.
    renderConformance();
    feed('Conformance ✓ — $validate OperationOutcome', 'conformance');

    //  (b) Acknowledgement of receipt — Task → received. Spine → Received.
    await delay(420);
    await store.updateTask({ type: 'updateTask', status: 'received', businessStatus: 'received', addProcedureNo: true, addOutputs: ['ack'] });
    revealRegulator();

    //  (c) Administrative validation (completeness/eligibility — fast, mechanical)
    //      → validation-successful. Spine → Validated (auto). NOT scientific review.
    await delay(560);
    await store.updateTask({ type: 'updateTask', status: 'accepted', businessStatus: 'validation-successful', addOutputs: ['validation'], flexibility: true });
    revealRegulator();
  }

  /* Brief presenter-paced delay so the automatic chain advances the spine calmly
     rather than snapping through every node at once. Instant if reduced-motion. */
  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /* The conformance check is automatic and in-flight. Render a small sober
     "Conformance ✓" tag on the landed payload, linked to the real $validate
     OperationOutcome in Inspect. Reflects an actual OperationOutcome severity. */
  function renderConformance() {
    var oo = store.conformance;
    var sev = ooSeverity(oo);
    var ok = sev !== 'error';
    var tag = '<span class="conf-tag' + (ok ? ' conf-ok' : ' conf-err') + '">' +
      (ok ? 'Conformance ✓' : 'Conformance ✗') +
      '</span> <span class="conf-note">automatic · $validate</span>' +
      ' <button class="link-btn" data-inspect="conformance">view OperationOutcome</button>';
    var pkgHead = el('pkg') && el('pkg').querySelector('.pkg-head');
    if (pkgHead && !pkgHead.querySelector('.conf-tag')) {
      var div = document.createElement('div');
      div.className = 'conf-line';
      div.innerHTML = tag;
      el('pkg').insertBefore(div, pkgHead.nextSibling);
    }
  }

  /* Coarsest severity in an OperationOutcome ('error' | 'warning' | 'information'). */
  function ooSeverity(oo) {
    if (!oo || !oo.issue || !oo.issue.length) return 'information';
    var sevs = oo.issue.map(function (i) { return i.severity; });
    if (sevs.indexOf('fatal') >= 0 || sevs.indexOf('error') >= 0) return 'error';
    if (sevs.indexOf('warning') >= 0) return 'warning';
    return 'information';
  }

  function verifyLinkHtml() {
    if (!store.taskUrl) return '';
    return ' <a class="verify-link" href="' + esc(store.taskUrl) + '" target="_blank" rel="noopener">on public server ↗</a>';
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

  /* Send answers — the applicant's response-to-questions. Re-stamps Task.code
     and restarts the clock (clock-stop → under-assessment), returning the turn
     to the Regulator's Decision. */
  async function handleAnswers() {
    await store.updateTask({ type: 'updateTask', status: 'in-progress', businessStatus: 'clock-restart', taskCode: 'response-to-questions' });
    feed('Responded to RSI — Clock Restart', 'notif');
    renderRsi(true);   // reveal the sponsor's response under the question
    revealRegulator();
  }

  /* #5 RSI exchange — render the actual List of Questions (HA → Industry) and,
     once answered, the sponsor's rational response. A genuine quick back-and-
     forth between the two desks; codes (information-request / response-to-
     questions) and clock-stop/clock-restart mechanics are unchanged. */
  function renderRsi(withAnswer) {
    show('ind-rsi');
    var q = '<div class="conv-msg conv-ha">' +
      '<div class="conv-from">Health Authority · List of Questions <span class="conv-code">information-request</span></div>' +
      '<div class="conv-body">' + esc(APIX.RSI.question) + '</div></div>';
    var a = withAnswer
      ? '<div class="conv-msg conv-ind">' +
          '<div class="conv-from">SynthPharma AG · Response <span class="conv-code">response-to-questions</span></div>' +
          '<div class="conv-body">' + esc(APIX.RSI.answer) + '</div></div>'
      : '';
    el('rsi-conv').innerHTML = q + a;
  }

  /* ============================ HEALTH AUTHORITY ========================== */
  function revealRegulator() {
    if (!store.task) return;
    hide('ha-empty');
    show('ha-content');
    // #4 Declutter: a COMPACT one-line auto-validation strip, then the prominent
    // Received-documents block (the main element of the pane).
    el('reg-status').innerHTML = regAutoLineHtml();
    el('reg-docs').innerHTML =
      '<div class="payload-head">Received documents</div>' + regDocsHtml(store.task.input);
    updateRegOutputs(store.task);
  }

  /* The automatic-chain summary, condensed to ONE compact line: the payload
     arrived conformant, received, and administratively validated — no human act.
     Each tick reflects state actually reached; OperationOutcome stays inspectable. */
  function regAutoLineHtml() {
    if (!store.task) return '';
    var ok = ooSeverity(store.conformance) !== 'error';
    var rec = !!reached['received'];
    var val = !!reached['validation-successful'];
    function tick(on, label) { return '<span class="auto-tag' + (on ? ' on' : '') + '">' + (on ? '✓ ' : '') + esc(label) + '</span>'; }
    return '<div class="reg-auto-line"><span class="reg-auto-lbl">Automatic on receipt</span>' +
      tick(ok, 'Conformant') + tick(rec, 'Received') + tick(val, 'Validated') +
      ' <button class="link-btn" data-inspect="conformance">OperationOutcome</button>' +
      ' <button class="link-btn" data-inspect="task">view Task</button></div>';
  }

  /* Prominent received-document cards for the HA pane. The whole card is the
     affordance — clicking opens the layered APIX-wrapper view (#2/#4). */
  function regDocsHtml(inputs) {
    return inputs.map(function (inp) {
      var d = store.get(inp.valueReference.reference);
      var ct = d ? d.content[0].attachment.contentType : 'application/pdf';
      var size = d ? d.content[0].attachment.size : 0;
      var ttype = inp.type.coding[0].code;
      var ic = ct === 'application/fhir+json' ? 'FHIR' : 'PDF';
      return '<button class="reg-doc" data-inspect="ref:' + esc(inp.valueReference.reference) + '">' +
        '<span class="reg-doc-ic">' + ic + '</span>' +
        '<span class="reg-doc-main">' +
          '<span class="reg-doc-title">' + esc(inp.valueReference.display) + '</span>' +
          '<span class="reg-doc-meta"><code>' + esc(ttype) + '</code> · ' + esc(ct) + ' · ' + bytes(size) + '</span>' +
        '</span>' +
        '<span class="reg-doc-open">Open APIX wrapper →</span>' +
      '</button>';
    }).join('');
  }

  /* On any Task update, refresh the compact auto-line (its businessStatus moves)
     and the outputs list. Kept callable from the store 'task' event. */
  function updateRegStatus(task) {
    if (el('ha-content').hidden) return;
    el('reg-status').innerHTML = regAutoLineHtml();
    updateRegOutputs(task);
  }
  function updateRegOutputs(task) {
    if (task && task.output && task.output.length) {
      el('reg-outputs').innerHTML = '<div class="payload-head">Outputs sent back</div>' +
        task.output.map(function (o) {
          return '<div class="doc"><span class="doc-ic">PDF</span><span class="doc-title">' + esc(o.valueReference.display) + '</span></div>';
        }).join('');
    }
  }

  /* ============================ HA ① Assess ============================= */
  /* Assess — the regulator's HUMAN scientific/technical content review. This is
     the THIRD, distinct "validation": NOT the automatic conformance check, NOT
     the automatic administrative validation — it is the assessor reading the
     structured spec. It reveals the acceptance-criteria (Good/Bad batch) teeth
     and moves the Task to under-assessment. (Conformance + received +
     validation-successful already happened automatically on Submit.) */
  async function handleAssess() {
    await store.updateTask({ type: 'updateTask', status: 'in-progress', businessStatus: 'under-assessment' });
    revealRegulator();
    show('ha-review');
    renderValidation();   // machine-check the tested batch against the structured criteria
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
      ? '<div class="val-banner val-banner-fail">OUT OF SPECIFICATION</div>'
      : '<div class="val-banner val-banner-pass">All criteria met</div>';
    el('review-result').innerHTML =
      '<div class="val-sub">' + esc(batchLabel) + '</div>' +
      banner +
      '<table class="val-table"><thead><tr><th>Test</th><th>Criterion</th><th>Measured</th><th>Result</th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table>';
  }

  /* ============================ HA ② Decision =========================== */
  /* Three real APIX outcomes. Approve / Reject are terminal → Summary.
     Request information → clock-stop, the notification crosses to Industry, and
     Industry's "Send answers" lights up. */
  function finishDecision() {
    phase = 'done';
    turn = null;
    refreshControls();
    setTimeout(renderSummary, 700);
  }
  async function onDecision(kind) {
    if (phase !== 'decision' || turn !== 'ha' || inFlight) return;
    inFlight = true; refreshControls();
    try {
      if (kind === 'approve') {
        await store.updateTask({ type: 'updateTask', status: 'completed', businessStatus: 'approved', taskCode: 'approval', addOutputs: ['approval', 'assessment'] });
        done.decision = true;
        crossNotification('ind', 'Approved');
        finishDecision();
      } else if (kind === 'reject') {
        await store.updateTask({ type: 'updateTask', status: 'completed', businessStatus: 'rejected', taskCode: 'rejection', addOutputs: ['rejection'], statusReason: 'Acceptance criteria not met on the tested batch (out of specification).' });
        done.decision = true;
        crossNotification('ind', 'Rejected');
        finishDecision();
      } else if (kind === 'info') {
        if (infoAsked) return;
        await store.updateTask({ type: 'updateTask', status: 'on-hold', businessStatus: 'clock-stop', taskCode: 'information-request' });
        infoAsked = true;
        revealRegulator();
        renderRsi(false);   // the actual List of Questions lands on the Industry side
        feed('Received RSI — Clock Stop', 'notif');
        // Clock Stop. The RSI crosses to Industry; its "Send answers" lights up.
        passTurn(null, 'answers', 'ind', 'ind', 'Clock Stop · RSI');
      }
    } catch (e) {
      flashError('Decision failed');
    } finally {
      inFlight = false;
      refreshControls();
    }
  }

  /* Surface a transient error without a footer narration line: a brief flag on
     the progress text (the flow has no telling sentences). */
  function flashError(msg) {
    el('progress').textContent = msg;
    setTimeout(refreshControls, 2400);
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

  /* Today → With APIX + PQI — the superiority payoff. Each pair is grounded in
     docs/FDA-ALIGNMENT.md + the regulatory-review research spike; terse on purpose.
     The `now` strings carry inline <strong> emphasis, so they are NOT escaped. */
  var CONTRAST = [
    { k: 'Content',   today: 'Re-key spec tables from a PDF narrative', now: 'Read coded <strong>ObservationDefinition</strong>s directly' },
    { k: 'A change',  today: 'Prose to interpret',                       now: 'A <strong>computable range → range</strong> (2.0 → 1.5% w/w)' },
    { k: 'Status',    today: 'Poll for a gateway acknowledgement',       now: 'Live status <strong>pushed</strong> (FHIR Subscription)' },
    { k: 'Questions', today: 'By letter, out-of-band, weeks',            now: 'Structured, <strong>in-band</strong>, both sides subscribed' },
    { k: 'OOS batch', today: 'Buried in 300 pages',                      now: 'Acceptance criterion <strong>machine-checked</strong>' }
  ];
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
    var cxRows = CONTRAST.map(function (c) {
      return '<tr><td class="cx-aspect">' + c.k + '</td>' +
        '<td class="cx-today">' + c.today + '</td>' +
        '<td class="cx-now">' + c.now + '</td></tr>';
    }).join('');
    el('summary').hidden = false;
    el('summary').innerHTML =
      '<div class="sum-head">Cycle time</div>' +
      '<div class="ct-bars">' + rowsHtml + '</div>' +
      '<div class="ct-total">Total: <strong>' + (totalMs != null ? esc(fmtElapsed(totalMs)) : '—') + '</strong></div>' +
      '<div class="sum-contrast">' +
        '<div class="sum-head">Why this is superior</div>' +
        '<table class="cx-table"><thead><tr><th></th><th>Today</th><th class="cx-now-h">With APIX + PQI</th></tr></thead>' +
          '<tbody>' + cxRows + '</tbody></table>' +
        '<p class="cx-src">Grounded in FDA <strong>PQ-CMC</strong> (Module 3 → ObservationDefinition), ' +
          '<strong>KASA</strong>, <strong>ESG NextGen</strong> (REST poll, not push) and <strong>ICH Q12</strong>; ' +
          'structured two-way messaging has no production home today. See <strong>About / FDA context</strong>.</p>' +
      '</div>' +
      '<button class="btn-ghost future-toggle" id="future-toggle">Future state · AI-assisted review →</button>';
    el('summary').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /* Closing beat (opt-in): AI-assisted review, framed strictly inside FDA's
     Jan-2025 draft "risk-based credibility assessment framework"
     (docs/AI-FUTURE-STATE.md). Illustrative, low-risk COU, human-in-the-loop —
     AI supports, FDA decides. The thesis lands: structured content is what makes
     trustworthy AI assistance possible. */
  var AI_FLOW = [
    { who: 'AI',    title: 'Read',      desc: 'Parse the PQI Bundle; spot the EC change (range → range)' },
    { who: 'AI',    title: 'Check',     desc: 'Machine-test the batch vs the coded acceptance criteria' },
    { who: 'AI',    title: 'Draft',     desc: 'Compose the assessment note + risk flag' },
    { who: 'AI',    title: 'Recommend', desc: 'Hand to the assessor with a recommendation' },
    { who: 'Human', title: 'Decide',    desc: 'Assessor approves / asks / rejects' }
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
      '<div class="future-head">' +
        '<h3>Future state — AI-assisted review</h3>' +
        '<span class="future-badge">illustrative</span>' +
        '<span class="future-badge">FDA draft AI guidance · Jan 2025</span>' +
      '</div>' +
      '<div class="ai-flow">' + steps + '</div>' +
      '<p class="future-foot">A narrow, low-risk <code>Context of Use</code>, human-in-the-loop — AI <strong>supports</strong>, ' +
        'FDA <strong>decides</strong>; every step logged to <code>Provenance</code>. Possible only because the content is ' +
        '<strong>structured</strong> — not over a PDF.</p>';
    el('future').hidden = false;
    var tg = el('future-toggle'); if (tg) tg.disabled = true;
    el('future').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /* ============================ INSPECT ================================== */
  function openInspect() { el('inspect').hidden = false; el('inspect-toggle').setAttribute('aria-expanded', 'true'); el('inspect-toggle').classList.add('on'); }
  function closeInspect() { el('inspect').hidden = true; el('inspect-toggle').setAttribute('aria-expanded', 'false'); el('inspect-toggle').classList.remove('on'); }
  function toggleInspect() { if (el('inspect').hidden) openInspect(); else closeInspect(); }

  function inspectFocus(title, htmlOrObj, isHtml) {
    var body = isHtml ? htmlOrObj : '<pre class="modal-json">' + APIX.highlight(htmlOrObj) + '</pre>';
    el('inspect-focus').innerHTML = '<div class="if-title">' + esc(title) + '</div>' + body;
  }
  /* Plain-language gloss for the businessStatus the Task is currently in — so a
     non-technical viewer reads what the code MEANS, without hiding the code. */
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

  /* ---- #3 Human-readable Task card (IG-narrative style, fidelity intact) ----
     A clean labelled card a non-technical viewer can read, with a Raw FHIR JSON
     toggle that reveals the exact resource. */
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

  /* ---- #2 APIX wrapper view — layered, "how content is decoded into the
     APIX wrapper". Task ▸ input → DocumentReference ▸ → Binary (base64, with a
     real Decode toggle) ▸ → PQI Bundle. The Decode genuinely atob()-decodes the
     stored Binary.data and shows it equals the PQI Bundle. */
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

  /* Real Decode: base64-decode the stored Binary.data and render the resulting
     PQI Bundle (proving the Binary IS the PQI Bundle, not a separate copy). */
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

  function inspectKey(key) {
    if (key === 'task') renderTaskFocus();
    else if (key === 'harmonize') renderHarmonizeFocus();
    else if (key === 'wrapper') renderWrapperFocus();
    else if (key === 'conformance') inspectFocus('Conformance check — $validate OperationOutcome (automatic)', store.conformance || { resourceType: 'OperationOutcome', issue: [] });
    else if (key === 'notif') inspectFocus('Subscription notification Bundle', lastNotif);
    else if (key === 'fhir') inspectFocus('PQI FHIR Bundle', APIX.pqi.bundle || APIX.pqi.normalize());
    else if (key.indexOf('prov:') === 0) {
      var pid = key.slice(5);
      var pr = store.get('Provenance/' + pid);
      if (pr) inspectFocus('Provenance — audit record', pr);
    }
    else if (key.indexOf('ref:') === 0) {
      var ref = key.slice(4);
      // The structured spec document opens the layered APIX-wrapper view (#2);
      // other references fall back to a raw resource peek.
      if (ref === 'DocumentReference/docref-spec-fhir') { renderWrapperFocus(); }
      else {
        var r = store.get(ref);
        if (r) inspectFocus(r.resourceType + (r.content ? ' — ' + r.content[0].attachment.title : ''), r);
      }
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

  /* ====================== AUDIT TRAIL (FHIR Provenance) =================== */
  /* One row per Task lifecycle transition: When (recorded) | Who (agent) |
     What (target + activity) | Why (the businessStatus / Task.code transition).
     Framed to FDA's data-integrity "who/what/when/why" (21 CFR Part 11 / ALCOA). */
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
    var why = provWhy(p);
    return '<tr><td class="aud-when">' + esc(when) + '</td>' +
      '<td>' + provWho(p) + '</td>' +
      '<td>' + provWhat(p) + '</td>' +
      '<td class="aud-why">' + esc(why) +
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
      '<table class="grid audit-table"><thead><tr>' +
        '<th>When</th><th>Who</th><th>What</th><th>Why</th>' +
      '</tr></thead><tbody>' + auditEntries.map(renderAuditEntry).join('') + '</tbody></table>';
  }
  function addAudit(p) { auditEntries.push(p); renderAudit(); }

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
    var msg = APIX.display('businessStatus', code);
    feed(msg, 'notif');
    setTimeout(function () {
      reached[code] = new Date();
      renderSpine();
    }, 520);
  });
  /* Each Task lifecycle transition emits a FHIR Provenance → the audit trail. */
  store.bus.addEventListener('provenance', function (ev) { addAudit(ev.detail.provenance); });

  /* Real API calls feed the Inspect list. */
  APIX.client.bus.addEventListener('io', function (ev) { addIo(ev.detail); });

  /* ============================ RESET =================================== */
  function resetAll() {
    turn = 'ind'; phase = 'author'; done = {}; infoAsked = false;
    reached = {}; lastNotif = null; ioEntries = []; auditEntries = [];
    inFlight = false;
    batchKey = 'good'; specMode = 'doc';
    store.reset();
    renderAudit();
    el('xing').hidden = true; el('xing').className = 'xing';
    el('pane-ind').classList.remove('recv'); el('pane-ha').classList.remove('recv');
    ['ind-spec', 'ind-pkg', 'ind-rsi', 'ind-track', 'ha-content', 'ha-review', 'summary', 'future'].forEach(hide);
    show('ha-empty');
    ['ind-flow', 'ha-flow', 'consolidated', 'pkg', 'rsi-conv', 'feed', 'reg-docs', 'reg-status', 'reg-outputs', 'review-result', 'io-list', 'future'].forEach(function (id) { el(id).innerHTML = ''; });
    setIoCount(); closeInspect();
    setBatch('good');
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
    '<strong>APIX = pre-ballot</strong> (IG v0.1.0). This demo shows the transport half in FHIR — never "FDA\'s plan."</div>' +

    '<div class="inspect-sec" style="border-top:none">Three distinct &ldquo;validations&rdquo;</div>' +
    '<p class="muted">The word &ldquo;validation&rdquo; means three different things in this exchange. ' +
    'Only the third is a human act; the first two are automatic and in-flight (see ' +
    '<code>docs/REGULATORY-FLOW.md</code>).</p>' +
    '<table class="val-table about-table"><thead><tr><th>Step</th><th>What it is</th></tr></thead><tbody>' +
    '<tr><td><strong>Conformance check</strong> <em>(automatic)</em></td>' +
      '<td>FHIR <code>$validate</code> &rarr; <code>OperationOutcome</code> &mdash; format/profile conformance of the payload as it is submitted. Not a human act.</td></tr>' +
    '<tr><td><strong>Administrative validation</strong> <em>(automatic / fast)</em></td>' +
      '<td>The authority&rsquo;s completeness + correct-classification / eligibility check &mdash; fast, largely mechanical &rarr; <code>validation-successful</code>.</td></tr>' +
    '<tr><td><strong>Scientific assessment</strong> <em>(human)</em></td>' +
      '<td>The assessor&rsquo;s review of the structured acceptance-criteria (good/bad batch) &rarr; <code>under-assessment</code>. The Regulator&rsquo;s <strong>Assess</strong> button.</td></tr>' +
    '</tbody></table>' +
    '<p class="muted">Type IB realism: EMA issues a single <strong>Request for Supplementary Information (RSI)</strong>, ' +
    'not a formal Type II clock-stop. The APIX IG&rsquo;s own Type IB example uses <code>clock-stop</code>/<code>clock-restart</code> ' +
    'businessStatus, so we keep those authoritative codes but label the branch RSI. The <code>apix-business-status</code> ' +
    'CodeSystem is <strong>draft</strong> and APIX v0.1.0 is <strong>pre-ballot</strong>.</p>' +

    '<div class="inspect-sec">Where this fits at FDA</div>' +
    '<table class="val-table about-table"><thead><tr><th>FDA anchor</th><th>Alignment</th></tr></thead><tbody>' +
    '<tr><td><strong>PQ-CMC FHIR IG</strong> (FDA-funded, R5, eCTD Module 3)</td>' +
      '<td>Same FHIR R5, same BR&amp;R work group, same structured-spec model as FDA\'s own IG. ' +
      'Velexa is a film-coated tablet — a <strong>Solid Oral Dosage Form, inside PQ-CMC\'s current scope</strong>.</td></tr>' +
    '<tr><td><strong>KASA</strong> (CDER/OPQ structured assessment)</td>' +
      '<td>Our structured <code>PlanDefinition</code> + <code>ObservationDefinition</code> spec is the kind of ' +
      'structured input a KASA-style assessment consumes. <em>Production (SODF).</em></td></tr>' +
    '<tr><td><strong>ICH Q12 Established Conditions</strong></td>' +
      '<td>The Water-Content variation is a <strong>computable EC change</strong> — old range → new range on a ' +
      'named, coded test. <em>Final guidance.</em></td></tr>' +
    '<tr><td><strong>IDMP guidance · SPL · GSRS · openFDA</strong></td>' +
      '<td>PQI is a FHIR-native expression of the product / substance data FDA already standardizes. <em>Production.</em></td></tr>' +
    '<tr><td><strong>TMAP / DMAP / EMAP</strong></td>' +
      '<td>APIX-over-FHIR matches FDA\'s committed "external data interfaces / industry standards / interoperable" posture. <em>Published plans.</em></td></tr>' +
    '<tr><td><strong>ESG NextGen</strong> submit / status / acknowledge</td>' +
      '<td>APIX is the FHIR-native rendering of an ESG-NextGen-style submit-and-track API — NextGen is REST <em>poll</em> for status; APIX adds real-time push + structured workflow state. <strong>Complementary, not competing.</strong> <em>Production (REST, not FHIR).</em></td></tr>' +
    '<tr><td><strong>eCTD v4.0 two-way comms</strong></td>' +
      '<td>FDA <strong>removed</strong> two-way communication from current eCTD v4.0; structured in-band agency&harr;sponsor messaging has <strong>no production home today</strong> — exactly the gap our regulator&harr;industry loop models. <em>Deferred / unimplemented.</em></td></tr>' +
    '<tr><td><strong>21 CFR Part 11 / ALCOA</strong></td>' +
      '<td><code>Task</code> + <code>businessStatus</code> + versioning + <code>Provenance</code> = the ' +
      'who / what / when / why audit trail by design. <em>Regulation.</em></td></tr>' +
    '</tbody></table>' +

    '<div class="inspect-sec">Real vs Simulated</div>' +
    '<table class="val-table about-table"><thead><tr><th>Aspect</th><th>Status</th></tr></thead><tbody>' +
    '<tr><td>FHIR R5 resources (Task, DocumentReference, Binary, Subscription, Provenance, PQI Bundle)</td><td class="pass">Real &amp; conformant</td></tr>' +
    '<tr><td>Conformance to the APIX + PQI IGs (official HL7 validator)</td><td class="pass">Real (88 → 1 documented IG bug)</td></tr>' +
    '<tr><td><strong>Live</strong> mode: POST / GET / $validate over the wire</td><td class="pass">Real, against public hapi.fhir.org/baseR5</td></tr>' +
    '<tr><td><strong>Local HAPI</strong> mode: self-hosted R5 server</td><td class="pass">Real REST + real R5 WebSocket subscription push</td></tr>' +
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
    // #3 Task card: reveal the raw FHIR JSON.
    if (ev.target.closest('#tk-raw-toggle')) {
      var raw = el('tk-raw'), tg = el('tk-raw-toggle');
      if (raw) { raw.hidden = !raw.hidden; if (tg) tg.textContent = raw.hidden ? 'Show raw FHIR JSON' : 'Hide raw FHIR JSON'; }
      return;
    }
    // #2 APIX wrapper: actually base64-decode the stored Binary back to the PQI Bundle.
    if (ev.target.closest('#wl-decode')) {
      decodeWrapperBinary();
      return;
    }
    // Closing beat: reveal the AI-assisted-review future-state panel.
    if (ev.target.closest('#future-toggle')) {
      renderFuture();
      return;
    }
    var ins = ev.target.closest('[data-inspect]'); if (ins) { inspectKey(ins.getAttribute('data-inspect')); return; }
    var fa = ev.target.closest('[data-flow]'); if (fa) { runFlow(fa.getAttribute('data-flow')); return; }
    var b = ev.target.closest('[data-batch]'); if (b) { setBatch(b.getAttribute('data-batch')); if (el('review-result').innerHTML) renderValidation(); return; }
    var dec = ev.target.closest('[data-decision]'); if (dec) { onDecision(dec.getAttribute('data-decision')); return; }
    var m = ev.target.closest('[data-mode]'); if (m) { specMode = m.getAttribute('data-mode'); renderConsolidated(); return; }
    var d = ev.target.closest('[data-doc]'); if (d) { openDoc(d.getAttribute('data-doc')); return; }
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
  refreshControls();
})();
