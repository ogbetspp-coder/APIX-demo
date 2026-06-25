/*
 * Terminology harmonization (Act 1). R5-compliant ConceptMaps that translate a
 * source system's LOCAL terms into the PQI controlled vocabularies + UCUM, plus a
 * small `translate()` that mirrors the ConceptMap/$translate operation.
 *
 * R5 notes (build.fhir.org/conceptmap.html): ConceptMap uses sourceScopeUri /
 * targetScopeUri, and group.element.target.relationship (NOT the R4 `equivalence`).
 */
window.APIX = window.APIX || {};

APIX.terminology = (function () {
  var LIMS_TESTS = 'http://synthpharma.example/fhir/CodeSystem/lims-test-codes';
  var LIMS_UNITS = 'http://synthpharma.example/fhir/CodeSystem/lims-units';
  var PQI_CS = 'http://hl7.org/fhir/uv/pharm-quality/CodeSystem/cs-local-codes-drug-pq-example';
  var SPONSOR_TESTS = 'http://synthpharma.example/fhir/CodeSystem/velexa-local-tests';
  var UCUM = 'http://unitsofmeasure.org';

  /* R5 ConceptMap: SynthPharma LIMS local test codes -> PQI drug spec codes. */
  var cmTests = {
    resourceType: 'ConceptMap',
    id: 'cm-lims-to-pqi-tests',
    url: 'http://synthpharma.example/fhir/ConceptMap/lims-to-pqi-tests',
    version: '1.0.0',
    name: 'LimsToPqiDrugTests',
    title: 'SynthPharma LIMS test codes → PQI drug-product specification codes',
    status: 'active',
    experimental: false,
    sourceScopeUri: LIMS_TESTS,
    targetScopeUri: PQI_CS,
    group: [{
      source: LIMS_TESTS,
      target: PQI_CS,
      element: [
        { code: 'DESCR',   display: 'Appearance',            target: [{ code: 'DESC',                    display: 'Description',             relationship: 'equivalent' }] },
        { code: 'ID-HPLC', display: 'ID (HPLC)',             target: [{ code: 'IDT',                     display: 'Identification',          relationship: 'equivalent' }] },
        { code: 'POT',     display: 'Potency',               target: [{ code: 'ASSAY',                   display: 'Assay',                   relationship: 'equivalent' }] },
        { code: 'DISSO',   display: 'Dissolution profile',   target: [{ code: 'Dissolution',             display: 'Dissolution',             relationship: 'equivalent' }] },
        { code: 'DEGR',    display: 'Related substances',    target: [{ code: 'DGP',                     display: 'Degradation Products',    relationship: 'source-is-narrower-than-target' }] },
        { code: 'KF',      display: 'Karl Fischer water',    target: [{ code: 'WaterContent',            display: 'Water Content',           relationship: 'equivalent' }] },
        { code: 'MICRO',   display: 'Micro limits',          target: [{ code: 'Microbiological Quality', display: 'Microbiological Quality', relationship: 'equivalent' }] }
      ]
    }]
  };

  /* R5 ConceptMap: LIMS nitrosamine code -> the sponsor-local NDSRI test code
     (the new test this supplement adds; not in the PQI example CS). */
  var cmNitro = {
    resourceType: 'ConceptMap',
    id: 'cm-lims-to-ndsri',
    url: 'http://synthpharma.example/fhir/ConceptMap/lims-to-ndsri',
    version: '1.0.0',
    name: 'LimsToNdsri',
    title: 'SynthPharma LIMS nitrosamine code → Velexa NDSRI test code',
    status: 'active',
    experimental: false,
    sourceScopeUri: LIMS_TESTS,
    targetScopeUri: SPONSOR_TESTS,
    group: [{
      source: LIMS_TESTS,
      target: SPONSOR_TESTS,
      element: [
        { code: 'NTRSM-LCMS', display: 'N-nitroso-velexate (LC-MS/MS)', target: [{ code: 'NDSRI', display: 'N-Nitroso-velexate (NDSRI)', relationship: 'equivalent' }] }
      ]
    }]
  };

  /* R5 ConceptMap: LIMS unit shorthand -> UCUM. */
  var cmUnits = {
    resourceType: 'ConceptMap',
    id: 'cm-lims-to-ucum',
    url: 'http://synthpharma.example/fhir/ConceptMap/lims-to-ucum',
    version: '1.0.0',
    name: 'LimsUnitsToUcum',
    title: 'SynthPharma LIMS unit shorthand → UCUM',
    status: 'active',
    experimental: false,
    sourceScopeUri: LIMS_UNITS,
    targetScopeUri: UCUM,
    group: [{
      source: LIMS_UNITS,
      target: UCUM,
      element: [
        { code: 'PCT_WW', display: '% w/w',            target: [{ code: '%', display: 'percent', relationship: 'equivalent' }] },
        { code: 'PCT_LC', display: '% of label claim', target: [{ code: '%', display: 'percent', relationship: 'equivalent' }] }
      ]
    }]
  };

  var conceptMaps = [cmTests, cmNitro, cmUnits];

  /* Mirror ConceptMap/$translate: return the first matching target Coding. */
  function translate(system, code) {
    for (var i = 0; i < conceptMaps.length; i++) {
      var g = conceptMaps[i].group[0];
      if (g.source !== system) continue;
      for (var j = 0; j < g.element.length; j++) {
        if (g.element[j].code === code) {
          var t = g.element[j].target[0];
          return { system: g.target, code: t.code, display: t.display, relationship: t.relationship };
        }
      }
    }
    return null;
  }

  /* Flat rows for the Act 1 harmonization animation (source ⟶ ConceptMap ⟶ target). */
  function rows() {
    var out = [];
    conceptMaps.forEach(function (cm) {
      var g = cm.group[0];
      g.element.forEach(function (e) {
        var t = e.target[0];
        out.push({
          conceptMap: cm.id,
          source: { system: g.source, code: e.code, display: e.display },
          target: { system: g.target, code: t.code, display: t.display },
          relationship: t.relationship
        });
      });
    });
    return out;
  }

  return {
    LIMS_TESTS: LIMS_TESTS, LIMS_UNITS: LIMS_UNITS, PQI_CS: PQI_CS, UCUM: UCUM,
    conceptMaps: conceptMaps, translate: translate, rows: rows
  };
})();
