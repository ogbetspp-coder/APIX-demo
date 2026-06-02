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
  var lastNotif = null;      // most recent notification Bundle (for peek)
  var apixDrawn = false;

  var APIX_STEPS = ['Connect', 'Stream', 'Describe', 'Orchestrate', 'Subscribe'];
  var REVIEW = [
    { key: 'receive', label: 'Acknowledge receipt' },
    { key: 'validate', label: 'Validate submission' },
    { key: 'assess', label: 'Scientific assessment' },
    { key: 'approve', label: 'Decision' }
  ];

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
    var step = S[i];
    if (step) {
      el('narration').textContent = step.narration;
      el('stepbtn').innerHTML = step.button + ' ▶';
      el('stepbtn').disabled = false;
      el('progress').textContent = 'Step ' + (i + 1) + ' / ' + S.length;
    } else {
      el('narration').innerHTML = '✅ <strong>Approved — end to end in minutes.</strong> Every status change was timestamped (your cycle-time analytics), and APIX carried both the PDF and the structured FHIR over the same rails.';
      el('stepbtn').innerHTML = 'Done'; el('stepbtn').disabled = true;
      el('progress').textContent = 'Complete';
      setStepper(4);
    }
    renderReview();
  }

  function runStep() {
    var step = S[i];
    if (!step) return;
    var act = actOf(step);
    showView(act); setStepper(act);
    if (act === 3) el('review').hidden = false;

    switch (step.effect.type) {
      case 'pull': handlePull(); break;
      case 'normalize': handleNormalize(); break;
      case 'render': show('b-formats'); show('a-render'); break;
      case 'connect': handleConnect(); break;
      case 'submit': handleSubmit(); break;
      case 'subscribe': handleSubscribe(); break;
      case 'updateTask':
        if (step.effect.flexibility) el('reg-flex').hidden = false;
        store.updateTask(step.effect);
        reviewDone[step.key] = true;
        break;
    }
    i += 1;
    refreshControls();
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
  function handleNormalize() {
    APIX.pqi.normalize(); show('a-normalize'); show('b-spec');
    var rows = APIX.pqi.specRows().map(function (r) {
      var shelf = r.changed
        ? '<span class="diff-old">' + esc(r.before) + '</span> → <span class="diff-new">' + esc(r.shelfLife) + ' w/w</span>'
        : esc(r.shelfLife);
      return '<tr' + (r.changed ? ' class="row-changed"' : '') + '><td>' + esc(r.test) +
        '</td><td class="dim">' + esc(r.method) + '</td><td>' + esc(r.release) + '</td><td>' + shelf + '</td></tr>';
    }).join('');
    el('spec').innerHTML = '<table class="spec-table"><thead><tr><th>Test</th><th>Method</th><th>Release</th><th>Shelf life</th></tr></thead><tbody>' +
      rows + '</tbody></table><p class="change-note">⚠ The only change in this variation: <strong>' +
      esc(APIX.pqi.CHANGE.label) + '</strong> — ' + esc(APIX.pqi.CHANGE.before) + ' → <strong>' + esc(APIX.pqi.CHANGE.after) + '</strong></p>';
  }

  /* ---- ACT 2 ------------------------------------------------------------ */
  function drawApixSteps() {
    el('apixsteps').innerHTML = APIX_STEPS.map(function (s, n) {
      return '<div class="astep" id="astep-' + n + '"><span class="tick">✓</span>' + esc(s) + '</div>';
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
      var ic = ct === 'application/fhir+json' ? '{ }' : '📄';
      return '<div class="doc' + (spec ? ' doc-spec' : '') + '"><span class="doc-ic">' + ic + '</span>' +
        '<span class="doc-ct">' + esc(inp.type.coding[0].code) + '</span>' +
        '<span class="doc-title">' + esc(inp.valueReference.display) + '</span>' +
        '<span class="doc-size">' + bytes(size) + '</span>' +
        '<button class="peek" data-peek="' + inp.valueReference.reference + '">View</button></div>';
    }).join('');
  }
  function handleConnect() {
    store.connect();
    el('conn').className = 'conn connected';
    el('conn').innerHTML = '<span class="dot"></span> Connected · Bearer token · Organization + Endpoint registered';
    markApix('Connect');
  }
  function handleSubmit() {
    store.submit();
    var t = store.task;
    el('pkg').hidden = false;
    el('pkg').innerHTML = '<div class="pkg-head">Submission package · ' + t.input.length +
      ' documents <button class="peek" data-peek="Task">View Task { }</button></div>' + docsHtml(t.input);
    markApix('Stream'); markApix('Describe'); markApix('Orchestrate');
    flyChip('📦 ' + t.input.length + ' documents →', 'right');
    setTimeout(revealRegulator, 950);
  }
  function revealRegulator() {
    el('inbox-empty').hidden = true; el('reg').hidden = false;
    el('reg-docs').innerHTML = '<div class="payload-head">Received documents</div>' + docsHtml(store.task.input);
    updateRegStatus(store.task);
  }
  function handleSubscribe() {
    store.subscribe();
    markApix('Subscribe');
    el('loopnote').hidden = false;
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
          return '<div class="doc"><span class="doc-ic">📄</span><span class="doc-title">' + esc(o.valueReference.display) + '</span></div>';
        }).join('');
    }
  }
  function renderReview() {
    if (el('review').hidden) return;
    var next = S[i];
    var activeKey = (next && actOf(next) === 3) ? next.key : null;
    el('review').innerHTML = '<div class="review-head">Regulatory review</div>' + REVIEW.map(function (it) {
      var cls = 'ritem' + (reviewDone[it.key] ? ' done' : '') + (it.key === activeKey ? ' active' : '');
      return '<div class="' + cls + '"><span class="rdot">' + (reviewDone[it.key] ? '✓' : '') + '</span>' + esc(it.label) + '</div>';
    }).join('');
  }
  function renderTracker(markCode, justNow) {
    if (markCode) reached[markCode] = new Date();
    el('tracker').innerHTML = '<div class="tracker-head">Live submission tracking ' +
      (lastNotif ? '<button class="peek" data-peek="notif">last notification { }</button>' : '') + '</div>' +
      APIX.businessStatusFlow.map(function (m) {
        var done = !!reached[m.code];
        var ts = done ? reached[m.code].toLocaleTimeString() : '';
        return '<div class="tnode ' + (done ? 'done' : '') + (m.code === justNow ? ' just' : '') + '">' +
          '<span class="tdot">' + (done ? m.icon : '○') + '</span><span class="tlbl">' + esc(m.label) +
          '</span><span class="tts">' + ts + '</span></div>';
      }).join('');
  }

  /* ---- modal / peeks ---------------------------------------------------- */
  function openModal(html) { el('modal-body').innerHTML = html; el('modal').hidden = false; }
  function openJson(title, obj) { openModal('<h2 class="modal-title">' + esc(title) + '</h2><pre class="modal-json">' + APIX.highlight(obj) + '</pre>'); }
  function openDoc(kind) {
    if (kind === 'pdf') openModal('<h2 class="modal-title">📄 Rendered eCTD 3.2.P.5.1 (PDF view)</h2>' + APIX.pqi.renderSpecHtml());
    else if (kind === 'fhir') openJson('{ } PQI FHIR Bundle — Bundle-drug-product-specification-pq', APIX.pqi.bundle || APIX.pqi.normalize());
    else if (kind === 'validate') {
      var rows = APIX.pqi.validate().map(function (v) {
        return '<tr><td>' + esc(v.test) + '</td><td>' + esc(v.criterion) + '</td><td>' + esc(v.measured) +
          '</td><td class="pass">✓ PASS</td></tr>';
      }).join('');
      openModal('<h2 class="modal-title">✓ Structured validation — batch vs. acceptance criteria</h2>' +
        '<p class="muted">Read directly from the PQI ObservationDefinitions — no transcription from a PDF.</p>' +
        '<table class="val-table"><thead><tr><th>Test</th><th>Criterion</th><th>Measured</th><th>Result</th></tr></thead><tbody>' + rows + '</tbody></table>');
    }
  }
  function openPeek(ref) {
    if (ref === 'Task') openJson('{ } Task — Type IB variation', store.task);
    else if (ref === 'notif') openJson('{ } Subscription notification Bundle', lastNotif);
    else { var r = store.get(ref); if (r) openJson('{ } ' + r.resourceType + (r.content ? ' — ' + r.content[0].attachment.title : ''), r); }
  }

  /* ---- store events ----------------------------------------------------- */
  store.bus.addEventListener('task', function (ev) {
    if (!el('reg').hidden && !ev.detail.firstTime) updateRegStatus(ev.detail.task);
  });
  store.bus.addEventListener('notification', function (ev) {
    lastNotif = ev.detail.bundle;
    flyChip('🔔 ' + APIX.display('businessStatus', ev.detail.businessStatus), 'left');
    setTimeout(function () { renderTracker(ev.detail.businessStatus, ev.detail.businessStatus); }, 520);
  });

  /* ---- reset ------------------------------------------------------------ */
  function resetAll() {
    i = 0; reviewDone = {}; reached = {}; lastNotif = null; apixDrawn = false;
    store.reset();
    ['b-sources', 'a-normalize', 'b-spec', 'a-render', 'b-formats', 'pkg', 'tracker', 'reg', 'review', 'reg-flex', 'loopnote'].forEach(function (id) { el(id).hidden = true; });
    ['sources', 'spec', 'pkg', 'reg-docs', 'reg-outputs', 'reg-status', 'review', 'apixsteps', 'lane'].forEach(function (id) { el(id).innerHTML = ''; });
    el('inbox-empty').hidden = false;
    el('conn').className = 'conn'; el('conn').innerHTML = '<span class="dot"></span> Not connected';
    el('view-exchange').hidden = true; el('view-author').hidden = false;
    refreshControls();
  }

  /* ---- wiring ----------------------------------------------------------- */
  document.addEventListener('click', function (ev) {
    var d = ev.target.closest('[data-doc]'); if (d) { openDoc(d.getAttribute('data-doc')); return; }
    var p = ev.target.closest('[data-peek]'); if (p) { openPeek(p.getAttribute('data-peek')); return; }
  });
  el('stepbtn').addEventListener('click', runStep);
  el('resetbtn').addEventListener('click', resetAll);
  el('modal-close').addEventListener('click', function () { el('modal').hidden = true; });
  el('modal').addEventListener('click', function (ev) { if (ev.target === el('modal')) el('modal').hidden = true; });

  setStepper(1);
  refreshControls();
})();
