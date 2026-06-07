/*
 * PQI (Pharmaceutical Quality, HL7 uv-dx-pq) module — Act 1 of the demo.
 *
 * Models the REAL uv-dx-pq drug-product specification structure:
 *   Bundle -> PlanDefinition (actions grouped by "Release" vs "End of shelf life")
 *          -> each test is an ObservationDefinition (code + method + qualifiedValue)
 *
 * Story: spec data is scattered across mocked source systems; we normalise it to
 * the PQI schema, then render it BOTH as a human eCTD 3.2.P.5.1 PDF and as the
 * structured FHIR Bundle. The variation being submitted = establishing an
 * N-nitroso-velexate (NDSRI) acceptance criterion and adding a confirmatory
 * LC-MS/MS test, filed as a US Prior Approval Supplement. The limit is not typed
 * in — it is COMPUTED: limit (ppm) = acceptable intake (ng/day) ÷ max daily dose
 * (mg/day), a calculation a PDF cannot do but structured data does for free.
 *
 * NOTE: criteria are adapted from the published uv-dx-pq example
 * (bundle-drug-product-specification-pq-ex1) for an illustrative, legible demo.
 */
window.APIX = window.APIX || {};

APIX.pqi = (function () {
  var PQ = 'http://hl7.org/fhir/uv/pharm-quality';
  var LOCAL_CS = PQ + '/CodeSystem/cs-local-codes-drug-pq-example';
  var TEXT_EXT = PQ + '/StructureDefinition/Extension-qualified-value-text-pq';
  var BUNDLE_PROFILE = PQ + '/StructureDefinition/Bundle-drug-product-specification-pq';

  /* The nitrosamine (NDSRI) limit is DERIVED, per FDA's nitrosamine guidance:
     limit (ppm) = AI (ng/day) ÷ MDD (mg/day). 1 ppm = 1 ng/mg.
       AI  = 100 ng/day  — CPCA Category 2 for N-nitroso-velexate
       MDD = 350 mg/day  — 2 × 175 mg tablets (label max daily dose)            */
  var NDSRI = { ai: 100, mdd: 350, dp: 2 };
  NDSRI.limit = +(NDSRI.ai / NDSRI.mdd).toFixed(NDSRI.dp);   // = 0.29 ppm (computed)

  /* The regulatory change carried by this variation. */
  var CHANGE = {
    test: 'NDSRI',
    label: 'New N-nitroso-velexate (NDSRI) limit + LC-MS/MS test',
    before: '— (not in current specification)',
    after: 'NMT ' + NDSRI.limit.toFixed(NDSRI.dp) + ' ppm',
    rationale: 'A new coded acceptance criterion added per the nitrosamine risk assessment; the limit is computed from the acceptable intake (' +
      NDSRI.ai + ' ng/day, CPCA Category 2) ÷ the maximum daily dose (' + NDSRI.mdd + ' mg/day). Filed as a Prior Approval Supplement (21 CFR 314.70(b)) to the NDA.'
  };

  /* ---- Mocked source systems (heterogeneous, "messy") -------------------
     Each system earns its place: it contributes a DISTINCT part of the spec.   */
  var sources = [
    {
      system: 'Analytical Method Repository',
      tag: 'REST',
      role: 'the new test + acceptance criterion',
      note: 'Validated LC-MS/MS method + the NDSRI limit, derived from AI ÷ MDD',
      rows: [
        'M-031  N-nitroso-velexate by LC-MS/MS',
        'AI  = 100 ng/day   (CPCA Category 2)',
        'MDD = 350 mg/day   (2 × 175 mg)',
        'limit = AI ÷ MDD = 0.29 ppm'
      ]
    },
    {
      system: 'Stability System — shelf-life data',
      tag: 'XML',
      role: 'the shelf-life justification',
      note: '36-month data: N-nitroso-velexate stays within the limit through shelf life',
      rows: [
        'NDSRI   0m : 0.08 ppm',
        'NDSRI  12m : 0.10 ppm',
        'NDSRI  24m : 0.12 ppm',
        'NDSRI  36m : 0.12 ppm    ≤ 0.29 ✓'
      ]
    },
    {
      system: 'LIMS — QC batch release',
      tag: 'CSV',
      role: 'the tested-batch result',
      note: 'Measured values for the batch screened against the spec',
      rows: [
        'ASSAY  99.0 %LC',
        'DISSO  Q = 86% @ 30 min',
        'WATER  1.8 % (shelf-life)',
        'NDSRI  0.45 ppm    → exceeds 0.29 ✗'
      ]
    }
  ];

  /* ---- Canonical spec model (the normalised "truth") -------------------- */
  /* Each test: code/display/method + release + shelfLife acceptance criteria.
     criteria are either { text } or { ranges: [{ appliesTo, high, unit }] }.   */
  var tests = [
    { code: 'DESC', display: 'Description', method: 'Visual inspection',
      release: { text: 'An orange film-coated tablet, debossed with 175 on one side' },
      shelfLife: { text: 'As for release' } },
    { code: 'IDT', display: 'Identification', method: 'ID by UHPLC',
      release: { text: 'Consistent with the retention time and UV spectrum of the reference standard' },
      shelfLife: { text: 'As for release' } },
    { code: 'ASSAY', display: 'Assay', method: 'Assay by UHPLC',
      release: { text: '95% to 105% of label claim' },
      shelfLife: { text: 'As for release' } },
    { code: 'Dissolution', display: 'Dissolution', method: 'Apparatus 2 (paddles), UV measurement',
      release: { text: 'Q = 80% at 30 minutes (harmonised USP / JP / Ph Eur)' },
      shelfLife: { text: 'As for release' } },
    { code: 'DGP', display: 'Degradation Products', method: 'Degradation products by UHPLC', impurity: true,
      release: { ranges: [
        { appliesTo: 'Impurity 1', high: 0.2 }, { appliesTo: 'Impurity 2', high: 0.3 },
        { appliesTo: 'Impurity 3', high: 0.3 }, { appliesTo: 'Individual unspecified', high: 0.2 },
        { appliesTo: 'Total degradation products', high: 1.4 } ] },
      shelfLife: { ranges: [
        { appliesTo: 'Impurity 1', high: 0.5 }, { appliesTo: 'Impurity 2', high: 0.4 },
        { appliesTo: 'Impurity 3', high: 0.4 }, { appliesTo: 'Individual unspecified', high: 0.5 },
        { appliesTo: 'Total degradation products', high: 2.3 } ] } },
    { code: 'WaterContent', display: 'Water Content', method: 'USP <921>',
      release: { ranges: [{ high: 1.0 }] },
      shelfLife: { ranges: [{ high: 2.0 }] } },
    { code: 'NDSRI', display: 'N-Nitroso-velexate (NDSRI)', method: 'LC-MS/MS',
      system: 'http://synthpharma.example/fhir/CodeSystem/velexa-local-tests',   // sponsor-local: a new test not in the PQI example CS
      unit: 'ppm', dp: NDSRI.dp, ai: NDSRI.ai, mdd: NDSRI.mdd, computed: true,
      release: { ranges: [{ high: NDSRI.limit, unit: 'ppm', dp: NDSRI.dp }] },
      shelfLife: { ranges: [{ high: NDSRI.limit, unit: 'ppm', dp: NDSRI.dp }] },
      changed: true, added: true, beforeShelfLife: '— (not specified)' },   // <-- the variation: a NEW coded test
    { code: 'Microbiological Quality', display: 'Microbiological Quality', method: 'Ph Eur',
      release: { text: 'Shall comply with the requirements of the Ph Eur' },
      shelfLife: { text: 'Shall comply with the requirements of the Ph Eur' } }
  ];

  /* Format a numeric high limit with its unit ('% w/w' default, or 'ppm'). */
  function fmtLimit(high, unit, dp) {
    dp = (dp == null) ? 1 : dp;
    return unit === 'ppm' ? 'NMT ' + high.toFixed(dp) + ' ppm' : 'NMT ' + high.toFixed(dp) + '% w/w';
  }

  /* Render an acceptance criterion (release or shelfLife) as readable text. */
  function criterionText(c) {
    if (!c) return '—';
    if (c.text) return c.text;
    if (c.ranges) {
      return c.ranges.map(function (r) {
        return (r.appliesTo ? r.appliesTo + ': ' : '') + fmtLimit(r.high, r.unit, r.dp);
      }).join('; ');
    }
    return '—';
  }

  /* http canonical base for resources carried inside the collection Bundle
     (real example uses an http url + a urn:uuid fullUrl for each entry).      */
  var CANON_BASE = 'http://synthpharma.example/fhir';

  /* Build a single ObservationDefinition for a test at a given timing.
     `uuid` is the resource's real lowercase UUID (id + fullUrl + canonical).  */
  function buildOD(test, timing, uuid) {
    var c = timing === 'release' ? test.release : test.shelfLife;
    var od = {
      resourceType: 'ObservationDefinition',
      id: uuid,
      url: CANON_BASE + '/ObservationDefinition/' + uuid,
      title: test.display,
      status: 'active',
      code: { coding: [{ system: test.system || LOCAL_CS, code: test.code, display: test.display }], text: test.display }
    };
    if (timing === 'release' || !test.shelfLife.text || test.shelfLife.text !== 'As for release' || test.changed) {
      od.method = { text: test.method };
    }
    if (c.text) {
      od.qualifiedValue = [{ extension: [{ url: TEXT_EXT, valueString: c.text }] }];
    } else if (c.ranges) {
      od.qualifiedValue = c.ranges.map(function (r) {
        var qv = { range: { high: { value: r.high, unit: r.unit || '% w/w' } } };
        if (r.appliesTo) qv.appliesTo = [{ text: r.appliesTo }];
        return qv;
      });
      if (test.impurity) od.component = [{ code: { coding: [{ system: LOCAL_CS, code: 'IMP', display: 'Impurity' }] } }];
    }
    return od;
  }

  /* Build the four PQI "context" resources the Bundle profile mandates
     (Product-Identification, Drug-Ingredient, Component-Substance, Organization).
     Mirrors the published bundle-drug-product-specification-pq example with
     Velexa-appropriate values. Returns { entries, mpdUuid }.                   */
  function buildContext() {
    var orgUuid = APIX.uuid();
    var substanceUuid = APIX.uuid();
    var ingredientUuid = APIX.uuid();
    var mpdUuid = APIX.uuid();

    // Drug-substance manufacturer (Organization slice).
    var org = {
      resourceType: 'Organization',
      id: orgUuid,
      identifier: [{ system: 'urn:oid:2.16.840.1.113883.4.82', value: '3009912345' }],
      active: true,
      type: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/pharmaceutical-organization-type', code: 'drug-substance-manufacture', display: 'Drug Substance Manufacture' }] }],
      name: 'Helvetia Fine Chemicals AG',
      contact: [{ address: { line: ['14 Rue de la Synthese'], city: 'Geneva', state: 'Geneve', postalCode: '1201', country: 'Switzerland' } }]
    };

    // Active substance (Component-Substance slice).
    var substance = {
      resourceType: 'SubstanceDefinition',
      id: substanceUuid,
      manufacturer: [{ reference: 'Organization/' + orgUuid }],
      name: [{ name: 'Velexanol' }]
    };

    // Active ingredient (Drug-Ingredient slice).
    var ingredient = {
      resourceType: 'Ingredient',
      id: ingredientUuid,
      status: 'active',
      for: [{ reference: 'MedicinalProductDefinition/' + mpdUuid }],
      role: { coding: [{ system: 'http://hl7.org/fhir/ingredient-role', code: '100000072072', display: 'Active' }] },
      substance: { code: { reference: { reference: 'SubstanceDefinition/' + substanceUuid } } }
    };

    // Finished product (Product-Identification slice).
    var mpd = {
      resourceType: 'MedicinalProductDefinition',
      id: mpdUuid,
      description: 'Velexa 175 mg film-coated tablets',
      combinedPharmaceuticalDoseForm: { coding: [{ system: 'http://standardterms.edqm.eu', code: '10221000', display: 'Film-coated tablet' }] },
      route: [{ coding: [{ system: 'http://standardterms.edqm.eu', code: '20053000', display: 'Oral use' }] }],
      name: [{
        productName: 'Velexa 175 mg film-coated tablets',
        type: { coding: [{ system: PQ + '/CodeSystem/cs-productNameType-pq-example', code: 'Proprietary', display: 'Proprietary' }] },
        part: [{ part: '175 mg', type: { coding: [{ system: 'http://hl7.org/fhir/medicinal-product-name-part-type', code: 'StrengthPart', display: 'Strength part' }] } }]
      }]
    };

    return {
      mpdUuid: mpdUuid,
      entries: [
        { fullUrl: 'urn:uuid:' + mpdUuid, resource: mpd },
        { fullUrl: 'urn:uuid:' + ingredientUuid, resource: ingredient },
        { fullUrl: 'urn:uuid:' + substanceUuid, resource: substance },
        { fullUrl: 'urn:uuid:' + orgUuid, resource: org }
      ]
    };
  }

  /* Normalise the source data into the PQI Bundle. Returns + caches it. */
  function normalize() {
    var entries = [];
    var releaseActions = [];
    var shelfActions = [];

    tests.forEach(function (t) {
      var rel = buildOD(t, 'release', APIX.uuid());
      var shelf = buildOD(t, 'shelfLife', APIX.uuid());
      entries.push({ fullUrl: 'urn:uuid:' + rel.id, resource: rel });
      entries.push({ fullUrl: 'urn:uuid:' + shelf.id, resource: shelf });
      releaseActions.push({ code: { text: 'Test' }, definitionCanonical: rel.url });
      shelfActions.push({ code: { text: 'Test' }, definitionCanonical: shelf.url });
    });

    var ctx = buildContext();
    var planUuid = APIX.uuid();

    var plan = {
      resourceType: 'PlanDefinition',
      id: planUuid,
      url: CANON_BASE + '/PlanDefinition/' + planUuid,
      title: 'SPECIFICATION(S) FOR DRUG PRODUCT',
      status: 'active',
      subjectReference: { reference: 'MedicinalProductDefinition/' + ctx.mpdUuid, display: APIX.seed.product.name[0].productName },
      description: 'Finished-product release and shelf-life specification, normalised to PQI.',
      action: [{
        title: 'Specification(s) for Drug Product',
        code: { text: 'Overall set of actions' },
        action: [
          { title: 'Release', code: { text: 'Timing Group' }, timingTiming: { code: { text: 'Release time' } }, action: releaseActions },
          { title: 'End of shelf life', code: { text: 'Timing Group' }, timingTiming: { code: { text: 'At end of shelf life' } }, action: shelfActions }
        ]
      }]
    };

    APIX.pqi.bundle = {
      resourceType: 'Bundle',
      id: 'bundle-drug-product-specification',
      meta: { profile: [BUNDLE_PROFILE] },
      type: 'collection',
      entry: [{ fullUrl: 'urn:uuid:' + planUuid, resource: plan }].concat(ctx.entries).concat(entries)
    };
    return APIX.pqi.bundle;
  }

  /* Flat rows for the on-screen spec table. */
  function specRows() {
    return tests.map(function (t) {
      return {
        test: t.display,
        method: t.method,
        release: criterionText(t.release),
        shelfLife: criterionText(t.shelfLife),
        changed: !!t.changed,
        added: !!t.added,
        before: t.beforeShelfLife || null
      };
    });
  }

  /* Render the human-readable eCTD 3.2.P.5.1 "PDF" view (HTML). */
  function renderSpecHtml() {
    var rows = specRows().map(function (r) {
      var shelf;
      if (r.added) {
        shelf = '<span class="diff-new">' + r.shelfLife + '</span> <span class="row-badge">NEW</span>';
      } else if (r.changed) {
        shelf = '<span class="diff-old">' + r.before + '</span> <span class="diff-new">' + r.shelfLife + '</span>';
      } else {
        shelf = r.shelfLife;
      }
      return '<tr' + (r.changed ? ' class="row-changed"' : '') + '>' +
        '<td>' + r.test + '</td><td>' + r.method + '</td>' +
        '<td>' + r.release + '</td><td>' + shelf + '</td></tr>';
    }).join('');
    return '' +
      '<div class="ectd-doc">' +
        '<div class="ectd-head"><span>MODULE 3.2.P.5.1</span><span>SPECIFICATION — DRUG PRODUCT</span></div>' +
        '<h2>' + APIX.seed.product.name[0].productName + '</h2>' +
        '<p class="ectd-meta">Applicant: SynthPharma AG &nbsp;·&nbsp; NDA 215123 &nbsp;·&nbsp; Prior Approval Supplement (drug product specification)</p>' +
        '<table class="ectd-table"><thead><tr><th>Test</th><th>Analytical Method</th>' +
          '<th>Acceptance Criteria (Release)</th><th>Acceptance Criteria (Shelf Life)</th></tr></thead>' +
          '<tbody>' + rows + '</tbody></table>' +
        '<p class="ectd-foot">Change in this submission: <strong>' + CHANGE.label + '</strong> — new acceptance criterion <strong>' +
          CHANGE.after + '</strong>. ' + CHANGE.rationale + '</p>' +
      '</div>';
  }

  /* ---- Tested batches the regulator machine-checks against the spec --------
     Each batch carries measured values keyed by test code (+ a sub-key for the
     impurity ranges that have an `appliesTo`). GOOD = all in range; BAD = one
     deliberate breach (end-of-shelf-life Water Content 1.8% vs the tightened
     ≤ 1.5%). Values are read straight off these objects and compared against the
     structured ObservationDefinition criteria — no transcription from a PDF.    */
  var batches = {
    good: {
      label: 'Batch VX-2026-007 (representative)',
      values: {
        DESC: 'conforms', IDT: 'conforms', ASSAY: 99.2, Dissolution: 88,
        WaterContent: 1.3,
        NDSRI: 0.12,                               // ≤ 0.29 ppm ✓
        'Microbiological Quality': 'conforms',
        DGP: { 'Total degradation products': 1.9, 'Individual unspecified': 0.3 }
      }
    },
    bad: {
      label: 'Batch VX-2026-011 (out-of-spec)',
      values: {
        DESC: 'conforms', IDT: 'conforms', ASSAY: 99.0, Dissolution: 86,
        WaterContent: 1.8,                         // ≤ 2.0% w/w ✓
        NDSRI: 0.45,                               // > 0.29 ppm ✗  (the breach)
        'Microbiological Quality': 'conforms',
        DGP: { 'Total degradation products': 2.0, 'Individual unspecified': 0.3 }
      }
    }
  };

  /* The subset of tests we surface in the regulator's structured check, with a
     readable label and which timing (shelf-life is where the variation bites).  */
  var CHECKS = [
    { code: 'ASSAY',        timing: 'release',   label: 'Assay (release)' },
    { code: 'Dissolution',  timing: 'release',   label: 'Dissolution (release)' },
    { code: 'WaterContent', timing: 'shelfLife', label: 'Water Content (end of shelf life)' },
    { code: 'DGP',          timing: 'shelfLife', label: 'Total Degradation Products (shelf life)' },
    { code: 'NDSRI',        timing: 'shelfLife', label: 'N-Nitroso-velexate (NDSRI)' }
  ];

  function findTest(code) {
    for (var i = 0; i < tests.length; i++) if (tests[i].code === code) return tests[i];
    return null;
  }

  /* Pick the numeric high limit (and a readable criterion) for a check. For an
     impurity test we use the 'Total degradation products' range. */
  function limitFor(test, timing) {
    var c = timing === 'release' ? test.release : test.shelfLife;
    if (!c) return null;
    if (c.text) return { kind: 'text', text: c.text };
    if (c.ranges) {
      var r = test.impurity
        ? (function () { for (var i = 0; i < c.ranges.length; i++) if (c.ranges[i].appliesTo === 'Total degradation products') return c.ranges[i]; return c.ranges[0]; })()
        : c.ranges[0];
      return { kind: 'range', high: r.high, appliesTo: r.appliesTo || null, unit: r.unit || '% w/w', dp: (r.dp == null ? 1 : r.dp) };
    }
    return null;
  }

  /* Regulator-side: machine-check a tested batch against the structured criteria.
     Returns rows [{ test, criterion, measured, pass }]; computed, not hard-coded. */
  function validate(batchKey) {
    var batch = batches[batchKey] || batches.good;
    return CHECKS.map(function (chk) {
      var test = findTest(chk.code);
      var lim = limitFor(test, chk.timing);
      var raw = batch.values[chk.code];
      var measured, criterion, pass;

      if (!lim || lim.kind === 'text') {
        criterion = lim ? lim.text : '—';
        measured = (raw == null ? 'conforms' : String(raw));
        pass = true;                                 // text criteria: conforms
      } else {
        // numeric range → compare measured value to the high limit.
        var val = test.impurity && raw && typeof raw === 'object' ? raw['Total degradation products'] : raw;
        var unit = lim.unit || '% w/w', dp = (lim.dp == null ? 1 : lim.dp);
        var suffix = (unit === 'ppm') ? ' ppm' : '% w/w', mSuffix = (unit === 'ppm') ? ' ppm' : '%';
        criterion = '≤ ' + lim.high.toFixed(dp) + suffix;
        measured = (typeof val === 'number') ? val.toFixed(dp) + mSuffix : String(val);
        pass = (typeof val === 'number') ? (val <= lim.high + 1e-9) : true;
      }
      return { test: chk.label, criterion: criterion, measured: measured, pass: pass };
    });
  }

  return {
    sources: sources, tests: tests, CHANGE: CHANGE, ndsri: NDSRI, bundle: null, batches: batches,
    normalize: normalize, specRows: specRows, criterionText: criterionText,
    renderSpecHtml: renderSpecHtml, validate: validate
  };
})();
