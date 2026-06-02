/*
 * Seed FHIR R5 resources, modelled faithfully on the APIX IG example artifacts.
 *
 * Scenario: SynthPharma AG submits a routine Type IB variation to the finished
 * product specification of "Velexa 175 mg film-coated tablets" to a generic
 * Health Authority, and tracks it in real time.
 *
 * APIX 0.1.0 exchanges the submission as a Task whose inputs point to
 * DocumentReferences (-> Binary). MedicinalProductDefinition is NOT profiled by
 * APIX; it is included only as orientation "product context".
 */
window.APIX = window.APIX || {};

APIX.seed = {

  /* ---- Organizations ---------------------------------------------------- */
  applicant: {
    resourceType: 'Organization',
    id: 'org-synthpharma-ag',
    meta: { profile: [APIX.SYS.profile.org] },
    identifier: [{ use: 'official', system: 'https://spor.ema.europa.eu/v1/locations', value: 'LOC-100012345' }],
    active: true,
    type: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/organization-type', code: 'other', display: 'Marketing Authorisation Holder' }] }],
    name: 'SynthPharma AG',
    contact: [{
      name: { text: 'Dr. John Doe, Head of Regulatory Affairs' },
      telecom: [{ system: 'email', value: 'john.doe@synthpharma.example', use: 'work' }],
      address: { line: ['123 Synthetic Research Blvd'], city: 'Basel', postalCode: '4000', country: 'Switzerland' }
    }]
  },

  regulator: {
    resourceType: 'Organization',
    id: 'org-ema-srm-hmed',
    name: 'Health Authority – Regulatory Review Division',
    active: true,
    contact: [{
      name: { text: 'Scientific and Regulatory Management' },
      telecom: [{ system: 'email', value: 'regulatory@health-authority.example', use: 'work' }],
      address: { type: 'physical', city: 'Capital City', postalCode: '1083 HS', country: 'Country' }
    }]
  },

  /* ---- Endpoint (APIX Step 1 registers Organization + Endpoint) --------- */
  endpoint: {
    resourceType: 'Endpoint',
    id: 'endpoint-synthpharma',
    status: 'active',
    connectionType: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/endpoint-connection-type', code: 'hl7-fhir-rest' }] }],
    name: 'SynthPharma APIX notification endpoint',
    managingOrganization: { reference: 'Organization/org-synthpharma-ag' },
    payloadType: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/endpoint-payload-type', code: 'any' }] }],
    address: 'https://portal.synthpharma.example/fhir-subscription-notify'
  },

  /* ---- Product context (FHIR R5, NOT APIX-profiled) --------------------- */
  product: {
    resourceType: 'MedicinalProductDefinition',
    id: 'mpd-velexa175',
    identifier: [{ system: 'http://ema.europa.eu/fhir/mpid', value: 'MPID-EU-100000067890' }],
    type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/medicinal-product-type', code: 'MedicinalProduct' }] },
    domain: { coding: [{ system: 'http://hl7.org/fhir/medicinal-product-domain', code: 'Human', display: 'Human use' }] },
    status: { coding: [{ system: 'http://hl7.org/fhir/publication-status', code: 'active' }] },
    combinedPharmaceuticalDoseForm: { coding: [{ system: 'http://standardterms.edqm.eu', code: '10221000', display: 'Film-coated tablet' }] },
    route: [{ coding: [{ system: 'http://standardterms.edqm.eu', code: '20053000', display: 'Oral use' }] }],
    name: [{
      productName: 'Velexa 175 mg film-coated tablets',
      type: { coding: [{ system: 'http://hl7.org/fhir/CodeSystem/medicinal-product-name-type', code: 'ProprietaryName' }] }
    }]
  },

  /* ---- Mocked supporting documents (the rest of the variation package) -- */
  /* Built into Binary + DocumentReference at submit time (see js/store.js).  */
  supportingDocs: [
    { id: 'doc-cover',     ctd: '1.0',                   title: 'Cover Letter.pdf',                  size: 184000 },
    { id: 'doc-varform',   ctd: 'variation-application', title: 'Variation Application Form.pdf',    size: 262000 },
    { id: 'doc-justif',    ctd: '3.2.P.5.6',             title: 'Justification of Specification.pdf', size: 540000 },
    { id: 'doc-batch',     ctd: '3.2.P.5.4',             title: 'Batch Analyses.pdf',                size: 1230000 },
    { id: 'doc-stability', ctd: '3.2.P.8.1',             title: 'Stability Summary (36 months).pdf', size: 2100000 }
  ],

  /* ---- Real-time layer: SubscriptionTopic x2 + Subscription ------------- */
  topicCreate: {
    resourceType: 'SubscriptionTopic',
    id: 'TaskCreationWithOrganizationAssignedFilter',
    url: APIX.SYS.topicCreate,
    version: '0.1.0',
    name: 'TaskCreationWithOrganizationAssignedFilter',
    title: 'Task Assignment and Creation With Organization Filter',
    status: 'active',
    description: 'Notify an organization when it has been assigned a new Task.',
    resourceTrigger: [{ resource: 'Task', supportedInteraction: ['create'] }],
    canFilterBy: [{ resource: 'Task', filterParameter: 'owner', filterDefinition: 'http://hl7.org/fhir/SearchParameter/Task-owner', modifier: ['exact'] }]
  },

  topicStatus: {
    resourceType: 'SubscriptionTopic',
    id: 'TaskStatusChangeWithIdentifierFilter',
    meta: { profile: ['http://hl7.org/fhir/uv/apix/StructureDefinition/task-status-change-with-identifier-filter'] },
    url: APIX.SYS.topicStatus,
    version: '0.1.0',
    name: 'TaskStatusChangeWithIdentifierFilter',
    title: 'Task Status Change With Identifier Filter',
    status: 'active',
    description: 'Triggers when a Task.status value changes. Filterable by Task.identifier.',
    resourceTrigger: [{ resource: 'Task', supportedInteraction: ['update'], fhirPathCriteria: '%previous.status != %current.status' }]
  },

  subscription: {
    resourceType: 'Subscription',
    id: 'sub-velexa-status',
    meta: { profile: [APIX.SYS.profile.sub] },
    identifier: [{ system: 'http://synthpharma.example/subscriptions', value: 'velexa-variation-status-sub-001' }],
    status: 'active',
    topic: APIX.SYS.topicStatus,
    managingEntity: { reference: 'Organization/org-synthpharma-ag' },
    reason: 'Track review status transitions for the Velexa specification variation Task',
    filterBy: [{ resourceType: 'Task', filterParameter: 'identifier', value: APIX.SYS.taskIdSystem + '|urn:uuid:2c9f3a10-velexa-variation-0001' }],
    channelType: { system: APIX.SYS.channelType, code: 'rest-hook' },
    endpoint: 'https://portal.synthpharma.example/fhir-subscription-notify',
    heartbeatPeriod: 300,
    timeout: 5,
    contentType: 'application/fhir+json',
    content: 'full-resource'
  }
};

/* The stable Task identity used throughout the storyline. */
APIX.TASK_ID = 'task-velexa-variation';
APIX.TASK_UUID = 'urn:uuid:2c9f3a10-velexa-variation-0001';
