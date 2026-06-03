/*
 * UI controller — act-based, presentation-grade. Drives the presenter-paced
 * scenario across three acts (Author → Send → Review & track), keeps the raw
 * FHIR one click away ("View { }"), and makes the Subscription feedback loop
 * visually explicit. The FHIR data layer (APIX.store) is unchanged.
 */
(function () {
  var store = APIX.store;
  var S = APIX.scenario;
  var i = 0;                 // current step index
  var reviewDone = {};       // regulator review checklist progress
  var reached = {};          // applicant tracker milestones
  var lastNotif = null;      // most recent notification Bundle (for tracker peek)
  var notifLog = [];         // every notification Bundle, in order (conversation peeks)
  var apixDrawn = false;

  var APIX_STEPS = ['Connect', 'Stream', 'Describe', 'Orchestrate', 'Subscribe'];
  var REVIEW = [
    { key: 'receive', label: 'Acknowledge receipt' },
    { key: 'validate', label: 'Validate submission' },
    { key: 'assess', label: 'Scientific assessment' },
    { key: 'approve', label: 'Decision' }
  ];

  /* Plain-language phrasing for each businessStatus the regulator pushes back —
     used by the spelled-out Industry ⇄ Health Authority conversation log. */
  var BIZ_PLAIN = {
    'received': 'Acknowledged receipt — status now Received',
    'validation-successful': 'Validation successful — submission accepted for assessment',
    'under-assessment': 'Under assessment — scientific review has started',
    'approved': 'Approved — positive decision, approval letter attached',
    'rejected': 'Rejected — negative decision',
    'validation-failed': 'Validation failed — submission cannot be accepted',
    'clock-stop': 'Clock stopped — List of Questions issued, awaiting response',
    'decision-pending': 'Decision pending'
  };
  function bizPlain(code) { return BIZ_PLAIN[code] || APIX.display('businessStatus', code); }

  var ioEntries = [];        // captured { } request/response interactions
  var ioOpen = false;        // inspector drawer expanded?
  var batchKey = 'good';     // regulator's selected tested batch (good | bad)
  var decisionPending = false; // true while the ▶ engine has handed off to the regulator decision buttons
  var infoRoundDone = false; // a Request-information Q&A loop has already completed

  function el(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function bytes(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.round(n / 1e3) + ' KB'; }
  function actOf(step) {
    var t = step.effect.type;
    if (t === 'pull' || t === 'normalize' || t === 'render') return 1;
    if (t === 'connect' || t === 'submit' || t === 'subscribe') return 2;
    return 3;
  }

  /* ---- views + stepper -------------------------------------------------- */
  function showView(act) {
    el('view-author').hidden = (act !== 1);
    if (act !== 1 && el('view-exchange').hidden) {
      el('view-exchange').hidden = false;
      if (!apixDrawn) { drawApixSteps(); apixDrawn = true; }
    }
  }
  function setStepper(act) {
    [].forEach.call(el('stepper').children, function (li) {
      var a = +li.getAttribute('data-act');
      li.classList.toggle('active', a === act);
      li.classList.toggle('done', a < act);
    });
  }

  /* ---- controls / step engine ------------------------------------------ */
  function refreshControls() {
    if (decisionPending) { lockStepForDecision(); renderReview(); return; }
    var step = S[i];
    if (step) {
      el('narration').textContent = step.narration;
      el('stepbtn').innerHTML = step.button + ' &rarr;';
      el('stepbtn').disabled = false;
      el('progress').textContent = 'Step ' + (i + 1) + ' / ' + S.length;
    } else {
      el('narration').innerHTML = terminalNarration || '<strong>Done — end to end in minutes.</strong> Every status change was timestamped (your cycle-time analytics), and APIX carried both the PDF and the structured FHIR over the same rails.';
      el('stepbtn').innerHTML = 'Done'; el('stepbtn').disabled = true;
      el('progress').textContent = 'Complete';
      setStepper(4);
    }
    renderReview();
  }
  var terminalNarration = null;   // set by a terminal Approve/Reject

  var inFlight = false;      // a step handler is awaiting (live latency guard)

  /* Run the current step. Handlers may be async (live mode does real network
     I/O); we await the handler before advancing `i`, and disable the ▶ button
     with a brief in-flight state so a fast double-click can't fire two steps
     under ~350 ms live latency. Mock stays effectively instant. */
  async function runStep() {
    if (inFlight) return;
    var step = S[i];
    if (!step) return;
    var act = actOf(step);
    showView(act); setStepper(act);
    if (act === 3) el('review').hidden = false;

    inFlight = true;
    var btn = el('stepbtn');
    btn.disabled = true;
    btn.classList.add('busy');

    try {
      switch (step.effect.type) {
        case 'pull': handlePull(); break;
        case 'normalize': handleNormalize(); break;
        case 'render': handleConsolidate(); break;
        case 'connect': await handleConnect(); break;
        case 'submit': await handleSubmit(); break;
        case 'subscribe': await handleSubscribe(); break;
        case 'updateTask':
          if (step.effect.flexibility) el('reg-flex').hidden = false;
          await store.updateTask(step.effect);
          reviewDone[step.key] = true;
          break;
        case 'decision':
          // Hand off to the regulator's three-way decision buttons. The linear
          // ▶ engine pauses here (decisionPending); it does NOT advance `i` until
          // a terminal Approve/Reject is chosen on the regulator panel.
          el('decision').hidden = false;
          decisionPending = true;
          break;   // leave `i` unchanged; refreshControls() locks ▶ while decisionPending
      }
      if (!decisionPending) i += 1;
    } catch (e) {
      el('narration').innerHTML = '<strong>Step failed:</strong> ' + esc(e && e.message ? e.message : String(e)) +
        (store._isLive ? ' — the public HAPI server may be busy; retry, or switch back to Mock.' : '');
    } finally {
      inFlight = false;
      btn.classList.remove('busy');
    }
    refreshControls();
  }

  /* While the decision is in the regulator's hands, the ▶ engine is parked: the
     button stays disabled with a hint, and the three decision buttons drive the
     next transition. Approve/Reject are terminal; Request information runs one
     Q&A loop then re-arms these same three buttons. */
  function lockStepForDecision() {
    el('stepbtn').innerHTML = 'Pick a decision &rarr;';
    el('stepbtn').disabled = true;
    el('narration').innerHTML = '<strong>Over to the regulator.</strong> On the Health Authority panel, pick an outcome: ' +
      '<strong>Approve</strong>, <strong>Request information</strong> (a clock-stop Q&amp;A loop), or <strong>Reject</strong>. Nothing auto-approves.';
  }
  function show(id) { el(id).hidden = false; }

  /* ---- ACT 1 ------------------------------------------------------------ */
  function handlePull() {
    show('b-sources');
    el('sources').innerHTML = APIX.pqi.sources.map(function (s) {
      return '<div class="src"><div class="src-head"><span class="src-name">' + esc(s.system) +
        '</span><span class="tag">' + esc(s.tag) + '</span></div><div class="src-note">' + esc(s.note) +
        '</div><pre class="src-rows">' + esc(s.rows.join('\n')) + '</pre></div>';
    }).join('');
  }
  /* Friendly relationship phrasing for a ConceptMap target.relationship. */
  function relText(rel) {
    if (rel === 'equivalent') return 'equivalent';
    if (rel === 'source-is-narrower-than-target') return 'narrower → broader';
    if (rel === 'source-is-broader-than-target') return 'broader → narrower';
    return esc(rel);
  }
  /* Act 1 · Harmonize — reveal each ConceptMap mapping one row at a time and
     fire a real ConceptMap/$translate per row (visible in the I/O inspector). */
  function handleNormalize() {
    show('a-normalize'); show('b-spec');
    var rows = APIX.terminology.rows();
    var host = el('harmonize');
    host.innerHTML = '';
    rows.forEach(function (r, n) {
      var div = document.createElement('div');
      div.className = 'hmap';
      div.innerHTML =
        '<span class="hm-src">' + esc(r.source.display) + ' <code>(' + esc(r.source.code) + ')</code></span>' +
        '<span class="hm-gate">⟨ConceptMap⟩</span>' +
        '<span class="hm-tgt">' + esc(r.target.display) + ' <code>(' + esc(r.target.code) + ')</code></span>' +
        '<span class="hm-rel">' + relText(r.relationship) + '</span>';
      host.appendChild(div);
      (function (row, node) {
        setTimeout(function () {
          node.classList.add('in');
          APIX.client.translate(row.source.system, row.source.code);
        }, 450 * n + 120);   // slower stagger so motion reads on a low-FPS Teams stream
      })(r, div);
    });
  }
  /* Act 1 · Consolidate — one card for the finished spec with a Document/FHIR
     toggle (Document = rendered eCTD; FHIR = highlighted PQI Bundle). */
  function renderConsolidated(mode) {
    var body = mode === 'fhir'
      ? '<pre class="modal-json cons-json">' + APIX.highlight(APIX.pqi.bundle) + '</pre>'
      : '<div class="cons-doc">' + APIX.pqi.renderSpecHtml() + '</div>';
    el('consolidated').innerHTML =
      '<div class="cons-card">' +
        '<div class="cons-top">' +
          '<div class="cons-title">Consolidated specification — Velexa 175&nbsp;mg</div>' +
          '<div class="seg" id="cons-seg">' +
            '<button class="seg-btn' + (mode !== 'fhir' ? ' on' : '') + '" data-mode="doc">Document</button>' +
            '<button class="seg-btn' + (mode === 'fhir' ? ' on' : '') + '" data-mode="fhir">FHIR</button>' +
          '</div>' +
        '</div>' +
        '<p class="cons-change">Change in this variation: <strong>' + esc(APIX.pqi.CHANGE.label) + '</strong> — ' +
          '<span class="diff-old">' + esc(APIX.pqi.CHANGE.before) + '</span> → <span class="diff-new">' + esc(APIX.pqi.CHANGE.after) + '</span></p>' +
        '<div class="cons-body">' + body + '</div>' +
      '</div>';
  }
  function handleConsolidate() {
    APIX.pqi.normalize();
    show('a-render'); show('b-formats');
    renderConsolidated('doc');
  }

  /* ---- ACT 2 ------------------------------------------------------------ */
  function drawApixSteps() {
    el('apixsteps').innerHTML = APIX_STEPS.map(function (s, n) {
      return '<div class="astep" id="astep-' + n + '"><span class="tick"></span>' + esc(s) + '</div>';
    }).join('');
  }
  function markApix(name) {
    var n = APIX_STEPS.indexOf(name);
    if (n >= 0) el('astep-' + n).classList.add('done');
  }
  function flyChip(text, dir) {
    var c = document.createElement('div');
    c.className = 'chip-fly ' + dir;
    c.textContent = text;
    el('lane').appendChild(c);
    setTimeout(function () { if (c.parentNode) c.parentNode.removeChild(c); }, 1200);
  }
  function docsHtml(inputs) {
    return inputs.map(function (inp) {
      var d = store.get(inp.valueReference.reference);
      var ct = d ? d.content[0].attachment.contentType : 'application/pdf';
      var size = d ? d.content[0].attachment.size : 0;
      var spec = inp.type.coding[0].code === '3.2.P.5.1';
      var ic = ct === 'application/fhir+json' ? 'FHIR' : 'PDF';
      return '<div class="doc' + (spec ? ' doc-spec' : '') + '"><span class="doc-ic">' + ic + '</span>' +
        '<span class="doc-ct">' + esc(inp.type.coding[0].code) + '</span>' +
        '<span class="doc-title">' + esc(inp.valueReference.display) + '</span>' +
        '<span class="doc-size">' + bytes(size) + '</span>' +
        '<button class="peek" data-peek="' + inp.valueReference.reference + '">View</button></div>';
    }).join('');
  }
  async function handleConnect() {
    await store.connect();
    el('conn').className = 'conn connected';
    el('conn').innerHTML = '<span class="dot"></span> Connected · Bearer token · Organization + Endpoint registered';
    markApix('Connect');
  }
  /* Live: a clickable link to the real Task on the public server we don't own. */
  function verifyLinkHtml() {
    if (!store.taskUrl) return '';
    return '<a class="verify-link" href="' + esc(store.taskUrl) + '" target="_blank" rel="noopener">View on public server ↗</a>';
  }
  async function handleSubmit() {
    await store.submit();
    var t = store.task;
    el('pkg').hidden = false;
    el('pkg').innerHTML = '<div class="pkg-head">Submission package · ' + t.input.length +
      ' documents <button class="peek" data-peek="Task">View Task</button> ' + verifyLinkHtml() + '</div>' + docsHtml(t.input);
    markApix('Stream'); markApix('Describe'); markApix('Orchestrate');
    flyChip(t.input.length + ' documents → delivered', 'right');
    setTimeout(revealRegulator, 950);
  }
  function revealRegulator() {
    if (!store.task) return;   // Reset may have fired during the reveal delay.
    el('inbox-empty').hidden = true; el('reg').hidden = false;
    el('reg-docs').innerHTML = '<div class="payload-head">Received documents</div>' + docsHtml(store.task.input);
    updateRegStatus(store.task);
  }
  async function handleSubscribe() {
    await store.subscribe();
    markApix('Subscribe');
    el('loopnote').hidden = false;
    if (store._isLive()) {
      el('loopnote').innerHTML = '<strong>FHIR Subscription</strong> registered on the server.<br>' +
        '<span class="live-note">UI reads the Task back after each change (production = a rest-hook webhook push).</span>';
    } else {
      el('loopnote').innerHTML = '<strong>FHIR Subscription</strong><br>Every status change is pushed back automatically — no polling, no email.';
    }
    el('tracker').hidden = false;
    renderTracker('submitted');
  }

  /* ---- ACT 3 ------------------------------------------------------------ */
  function updateRegStatus(task) {
    el('reg-status').innerHTML = '<span class="rs-label">Task status</span>' +
      '<span class="badge badge-status">' + esc(task.status) + '</span>' +
      '<span class="badge badge-biz">' + esc(task.businessStatus.coding[0].display) + '</span>' +
      (task.identifier.length > 1 ? '<span class="badge badge-proc">' + esc(task.identifier[1].value) + '</span>' : '');
    if (task.output && task.output.length) {
      el('reg-outputs').innerHTML = '<div class="payload-head">Outputs sent back</div>' +
        task.output.map(function (o) {
          return '<div class="doc"><span class="doc-ic">PDF</span><span class="doc-title">' + esc(o.valueReference.display) + '</span></div>';
        }).join('');
    }
  }
  function renderReview() {
    if (el('review').hidden) return;
    var next = S[i];
    var activeKey = (next && actOf(next) === 3) ? next.key : null;
    el('review').innerHTML = '<div class="review-head">Regulatory review</div>' + REVIEW.map(function (it) {
      var cls = 'ritem' + (reviewDone[it.key] ? ' done' : '') + (it.key === activeKey ? ' active' : '');
      return '<div class="' + cls + '"><span class="rdot"></span>' + esc(it.label) + '</div>';
    }).join('');
  }
  function renderTracker(markCode, justNow) {
    if (markCode) reached[markCode] = new Date();
    el('tracker').innerHTML = '<div class="tracker-head">Live submission tracking ' +
      (lastNotif ? '<button class="peek" data-peek="notif">last notification</button>' : '') + '</div>' +
      APIX.businessStatusFlow.map(function (m, n) {
        var done = !!reached[m.code];
        var ts = done ? reached[m.code].toLocaleTimeString() : '';
        return '<div class="tnode ' + (done ? 'done' : '') + (m.code === justNow ? ' just' : '') + '">' +
          '<span class="tdot">' + (n + 1) + '</span><span class="tlbl">' + esc(m.label) +
          '</span><span class="tts">' + ts + '</span></div>';
      }).join('');
  }

  /* ---- conversation log (Industry ⇄ Health Authority) ------------------- */
  /* Append one plain-language exchange line, with explicit direction and an
     optional "view { }" peek to the underlying FHIR resource/Bundle. */
  function convLine(dir, from, to, text, peek) {
    el('conversation').hidden = false;
    var row = document.createElement('div');
    row.className = 'conv-row ' + dir;
    row.innerHTML =
      '<span class="conv-dir">' + from + ' <span class="conv-arrow">→</span> ' + to + '</span>' +
      '<span class="conv-msg">' + text + '</span>' +
      (peek ? '<button class="conv-peek peek" data-peek="' + esc(peek) + '">view FHIR</button>' : '');
    el('conv-log').appendChild(row);
    el('conv-log').scrollTop = el('conv-log').scrollHeight;
  }

  /* ---- regulator decision branch (approve / request-info / reject) -------
     The ▶ engine parks at the `decision` step; these buttons drive the rest.
     Approve and Reject are terminal (advance `i` past the last step → the
     completion view + cycle-time summary + adoption panel render). Request
     information runs ONE clock-stop Q&A loop, then re-arms the three buttons. */
  function setDecisionBtns(enabled) {
    [].forEach.call(el('decision-btns').children, function (b) { b.disabled = !enabled; });
  }
  function finishDecision() {
    decisionPending = false;
    el('decision').hidden = true;
    i = S.length;                 // past the last step → completion view
    el('adoption').hidden = false;
    refreshControls();
    // The terminal notification's tracker stamp lands via a 520ms setTimeout;
    // render the cycle-time summary just after so reached[approved|rejected] is set.
    setTimeout(renderCycleTime, 700);
  }
  async function onDecision(kind) {
    if (!decisionPending || inFlight) return;
    inFlight = true; setDecisionBtns(false);
    try {
      if (kind === 'approve') {
        await store.updateTask({ type: 'updateTask', status: 'completed', businessStatus: 'approved', taskCode: 'approval', addOutputs: ['approval', 'assessment'] });
        reviewDone['approve'] = true;
        terminalNarration = '<strong>Approved — end to end in minutes.</strong> Every status change was timestamped (your cycle-time analytics below), and APIX carried both the PDF and the structured FHIR over the same rails.';
        finishDecision();
      } else if (kind === 'reject') {
        await store.updateTask({ type: 'updateTask', status: 'completed', businessStatus: 'rejected', taskCode: 'rejection', addOutputs: ['rejection'] });
        reviewDone['approve'] = true;
        convLine('in', 'Regulator', 'Industry', 'Negative decision — variation rejected', 'Task');
        terminalNarration = '<strong>Rejected — but still in minutes, fully tracked.</strong> The same APIX rails carry a negative decision; every phase is timestamped in the cycle-time summary below.';
        finishDecision();
      } else if (kind === 'info') {
        if (infoRoundDone) { setDecisionBtns(true); return; }   // one loop only
        // HA posts a List of Questions (clock-stop) ...
        await store.updateTask({ type: 'updateTask', status: 'on-hold', businessStatus: 'clock-stop', taskCode: 'information-request' });
        convLine('in', 'Regulator', 'Industry', 'List of Questions: justify the tightened end-of-shelf-life Water Content limit (≤ 1.5% w/w)', 'Task');
        // ... Industry responds (clock restart).
        await store.updateTask({ type: 'updateTask', status: 'in-progress', businessStatus: 'under-assessment', taskCode: 'response-to-questions' });
        convLine('out', 'Industry', 'Regulator', 'Response to questions: 36-month stability data supports ≤ 1.5% — clock restarts', 'Task');
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

  /* ---- end-of-run cycle-time summary (this run's REAL timestamps) --------- */
  var CT_PHASES = [
    { from: 'submitted', to: 'received',   label: 'Submitted → Received' },
    { from: 'received',  to: 'validation-successful', label: 'Received → Validated' },
    { from: 'validation-successful', to: 'under-assessment', label: 'Validated → Assessing' },
    { from: 'under-assessment', to: 'approved', label: 'Assessing → Approved', altTo: 'rejected' }
  ];
  function fmtElapsed(ms) {
    if (ms < 1000) return ms + ' ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + ' s';
    return (ms / 60000).toFixed(1) + ' min';
  }
  function renderCycleTime() {
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
    el('cycle-time').hidden = false;
    el('cycle-time').innerHTML =
      '<div class="ct-head">Cycle time — <strong>this run\'s real timestamps</strong> · every phase is now measured</div>' +
      '<div class="ct-bars">' + rowsHtml + '</div>' +
      '<div class="ct-total">Total (submit → decision): <strong>' + (totalMs != null ? esc(fmtElapsed(totalMs)) : '—') + '</strong></div>' +
      '<div class="ct-baseline">vs. <em>typical manual variation ≈ weeks</em> <span class="ct-illus">illustrative baseline — not a measured value</span></div>' +
      '<div class="ct-note">The point isn\'t the seconds on stage — it\'s that APIX makes cycle time <strong>measurable</strong>. That is the analytics value.</div>';
  }

  /* ---- "Why this matters" toggle (Today vs APIX value contrast) ----------- */
  function toggleValueContrast() {
    var vc = el('value-contrast');
    vc.hidden = !vc.hidden;
    el('why-btn').classList.toggle('on', !vc.hidden);
  }

  /* ---- I/O inspector (real request/response inspector) ------------------ */
  function ioStatusClass(status) {
    if (status >= 200 && status < 300) return 'ok';
    if (status >= 400) return 'err';
    return 'neu';
  }
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
    var st = e.response || {};
    var cls = ioStatusClass(st.status);
    var req = e.request || {};
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
        ((store.taskUrl && /Orchestrate/.test(e.label || '')) ? '<div class="io-verify">' + verifyLinkHtml() + '</div>' : '') +
      '</div>' +
    '</div>';
  }
  function setIoCount() { el('io-count').textContent = ioEntries.length; }
  function setDrawer(open) {
    ioOpen = open;
    el('io-drawer').hidden = !open;
    el('io-toggle').setAttribute('aria-expanded', open ? 'true' : 'false');
    el('io-toggle').classList.toggle('on', open);
  }
  function addIo(detail) {
    ioEntries.push(detail);
    setIoCount();
    var wrap = document.createElement('div');
    wrap.innerHTML = renderIoEntry(detail);
    el('io-list').appendChild(wrap.firstChild);
  }

  /* ---- modal / peeks ---------------------------------------------------- */
  function openModal(html) { el('modal-body').innerHTML = html; el('modal').hidden = false; }
  function openJson(title, obj) { openModal('<h2 class="modal-title">' + esc(title) + '</h2><pre class="modal-json">' + APIX.highlight(obj) + '</pre>'); }
  function openDoc(kind) {
    if (kind === 'pdf') openModal('<h2 class="modal-title">Rendered eCTD 3.2.P.5.1 (PDF view)</h2>' + APIX.pqi.renderSpecHtml());
    else if (kind === 'fhir') openJson('PQI FHIR Bundle — Bundle-drug-product-specification-pq', APIX.pqi.bundle || APIX.pqi.normalize());
    else if (kind === 'validate') {
      var results = APIX.pqi.validate(batchKey);
      var anyFail = results.some(function (v) { return !v.pass; });
      var batchLabel = (APIX.pqi.batches[batchKey] || {}).label || batchKey;
      var rows = results.map(function (v) {
        return '<tr' + (v.pass ? '' : ' class="val-fail-row"') + '><td>' + esc(v.test) + '</td><td>' + esc(v.criterion) + '</td><td>' + esc(v.measured) +
          '</td><td class="' + (v.pass ? 'pass' : 'fail') + '">' + (v.pass ? 'PASS' : 'FAIL') + '</td></tr>';
      }).join('');
      var banner = anyFail
        ? '<div class="val-banner val-banner-fail">OUT OF SPECIFICATION — acceptance criterion breached</div>' +
          '<p class="val-punch">In the 300-page PDF this is buried; in the structured spec the acceptance criterion is <strong>machine-checked — caught at submit.</strong></p>'
        : '<div class="val-banner val-banner-pass">All acceptance criteria met</div>';
      openModal('<h2 class="modal-title">Structured validation — ' + esc(batchLabel) + ' vs. acceptance criteria</h2>' +
        banner +
        '<p class="muted">Read directly from the PQI ObservationDefinitions — no transcription from a PDF.</p>' +
        '<table class="val-table"><thead><tr><th>Test</th><th>Criterion</th><th>Measured</th><th>Result</th></tr></thead><tbody>' + rows + '</tbody></table>');
    }
  }
  function openPeek(ref) {
    if (ref === 'Task') openJson('Task — Type IB variation', store.task);
    else if (ref === 'notif') openJson('Subscription notification Bundle', lastNotif);
    else if (ref.indexOf('notif-') === 0) openJson('Subscription notification Bundle', notifLog[+ref.slice(6)] || lastNotif);
    else { var r = store.get(ref); if (r) openJson(r.resourceType + (r.content ? ' — ' + r.content[0].attachment.title : ''), r); }
  }

  /* ---- store events ----------------------------------------------------- */
  store.bus.addEventListener('task', function (ev) {
    if (ev.detail.firstTime) {
      var msg = 'Submitted Type IB variation (Task created)' +
        (store.taskUrl ? ' ' + verifyLinkHtml() : '');
      convLine('out', 'Industry', 'Regulator', msg, 'Task');
    } else if (!el('reg').hidden) {
      updateRegStatus(ev.detail.task);
    }
  });
  store.bus.addEventListener('notification', function (ev) {
    lastNotif = ev.detail.bundle;
    var idx = notifLog.push(ev.detail.bundle) - 1;     // stable per-line peek target
    var msg = bizPlain(ev.detail.businessStatus);
    flyChip('← ' + APIX.display('businessStatus', ev.detail.businessStatus), 'left');
    convLine('in', 'Regulator', 'Industry', 'Notification: ' + esc(msg), 'notif-' + idx);
    setTimeout(function () { renderTracker(ev.detail.businessStatus, ev.detail.businessStatus); }, 520);
  });

  /* ---- client I/O feed (request/response inspector) --------------------- */
  APIX.client.bus.addEventListener('io', function (ev) { addIo(ev.detail); });

  /* ---- reset ------------------------------------------------------------ */
  function resetAll() {
    i = 0; reviewDone = {}; reached = {}; lastNotif = null; apixDrawn = false;
    ioEntries = []; notifLog = [];
    decisionPending = false; infoRoundDone = false; terminalNarration = null; batchKey = 'good';
    store.reset();
    ['b-sources', 'a-normalize', 'b-spec', 'a-render', 'b-formats', 'pkg', 'tracker', 'reg', 'review', 'reg-flex', 'decision', 'loopnote', 'conversation', 'cycle-time', 'adoption'].forEach(function (id) { el(id).hidden = true; });
    ['sources', 'harmonize', 'consolidated', 'pkg', 'reg-docs', 'reg-outputs', 'reg-status', 'review', 'apixsteps', 'lane', 'conv-log', 'io-list', 'cycle-time'].forEach(function (id) { el(id).innerHTML = ''; });
    setIoCount(); setDrawer(false);
    setBatch('good'); setDecisionBtns(true);
    el('value-contrast').hidden = false; el('why-btn').classList.add('on');
    el('inbox-empty').hidden = false;
    el('conn').className = 'conn'; el('conn').innerHTML = '<span class="dot"></span> Not connected';
    el('view-exchange').hidden = true; el('view-author').hidden = false;
    setStepper(1);
    refreshControls();
  }

  /* ---- backend toggle (Mock ⇄ Live) ------------------------------------- */
  function isLive() { return APIX.config && APIX.config.backend === 'hapi'; }
  function reflectBackend() {
    var live = isLive();
    el('backend-toggle').setAttribute('aria-pressed', live ? 'true' : 'false');
    el('backend-toggle').classList.toggle('live', live);
    el('backend-mock').classList.toggle('on', !live);
    el('backend-live').classList.toggle('on', live);
    el('live-indicator').hidden = !live;
  }
  function setBackend(backend) {
    if (!APIX.config) return;
    if (APIX.config.backend === backend) return;
    APIX.config.backend = backend;
    reflectBackend();
    resetAll();   // changing backend resets the run (fresh ids / server state)
  }

  var ABOUT_HTML =
    '<h2 class="modal-title">Real vs Simulated</h2>' +
    '<p class="muted">This demo is built on real, valid FHIR R5 — and you can verify it independently.</p>' +
    '<table class="val-table about-table"><thead><tr><th>Aspect</th><th>Status</th></tr></thead><tbody>' +
    '<tr><td>FHIR R5 resources (Task, DocumentReference, Binary, Subscription, PQI Bundle)</td><td class="pass">Real &amp; conformant</td></tr>' +
    '<tr><td>Conformance to the APIX + PQI IGs</td><td class="pass">Official HL7 validator (88 → 1 documented IG bug)</td></tr>' +
    '<tr><td><strong>Live</strong> mode: POST / GET / $validate over the wire</td><td class="pass">Real, against public hapi.fhir.org/baseR5</td></tr>' +
    '<tr><td>Server-assigned ids, ETags, OperationOutcome</td><td class="pass">Real (from the public server)</td></tr>' +
    '<tr><td>OAuth2 / SMART Backend Services token</td><td class="sim">Simulated (labeled; orthogonal to the exchange)</td></tr>' +
    '<tr><td>Real-time push delivery</td><td class="sim">Subscription is real; here the UI reads the Task back (production = rest-hook webhook)</td></tr>' +
    '</tbody></table>' +
    '<p class="muted">Mock mode is the stage default: fully offline, deterministic, instant. Live mode talks to a shared public server whose data is periodically auto-wiped.</p>';

  /* ---- batch toggle (regulator: good vs bad tested batch) ---------------- */
  function setBatch(key) {
    batchKey = key;
    el('batch-good').classList.toggle('on', key === 'good');
    el('batch-bad').classList.toggle('on', key === 'bad');
  }

  /* ---- wiring ----------------------------------------------------------- */
  document.addEventListener('click', function (ev) {
    var sum = ev.target.closest('.io-sum');
    if (sum) { var det = sum.parentNode.querySelector('.io-detail'); if (det) det.hidden = !det.hidden; return; }
    var b = ev.target.closest('[data-batch]'); if (b) { setBatch(b.getAttribute('data-batch')); return; }
    var dec = ev.target.closest('[data-decision]'); if (dec) { onDecision(dec.getAttribute('data-decision')); return; }
    var m = ev.target.closest('[data-mode]'); if (m) { renderConsolidated(m.getAttribute('data-mode')); return; }
    var d = ev.target.closest('[data-doc]'); if (d) { openDoc(d.getAttribute('data-doc')); return; }
    var p = ev.target.closest('[data-peek]'); if (p) { openPeek(p.getAttribute('data-peek')); return; }
  });
  el('why-btn').addEventListener('click', toggleValueContrast);
  el('io-toggle').addEventListener('click', function () { setDrawer(!ioOpen); });
  el('io-close').addEventListener('click', function () { setDrawer(false); });
  el('stepbtn').addEventListener('click', runStep);
  el('resetbtn').addEventListener('click', resetAll);
  el('modal-close').addEventListener('click', function () { el('modal').hidden = true; });
  el('modal').addEventListener('click', function (ev) { if (ev.target === el('modal')) el('modal').hidden = true; });
  el('backend-mock').addEventListener('click', function () { setBackend('mock'); });
  el('backend-live').addEventListener('click', function () { setBackend('hapi'); });
  el('about-btn').addEventListener('click', function () { openModal(ABOUT_HTML); });

  reflectBackend();
  el('why-btn').classList.add('on');   // value-contrast visible by default (toggle to hide)
  setStepper(1);
  refreshControls();
})();
