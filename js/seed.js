/*
 * Seed FHIR R5 resources, modelled faithfully on the APIX IG example artifacts.
 *
 * Scenario: SynthPharma AG submits a Prior Approval Supplement to the finished
 * drug-product specification of "Velexa 175 mg film-coated tablets" to FDA,
 * and tracks it in real time.
 *
 * APIX 0.1.0 exchanges the submission as a Task whose inputs point to
 * DocumentReferences (-> Binary). MedicinalProductDefinition is NOT profiled by
 * APIX; it is included only as orientation "product context".
 */
window.APIX = window.APIX || {};

/* The stable Task identity used throughout the storyline (real urn:uuid values). */
APIX.TASK_ID = 'task-velexa-variation';
APIX.TASK_UUID = 'urn:uuid:2c9f3a10-9b1e-47a6-8d3c-ca60a5189726';
/* Workflow group id (Task.groupIdentifier) — also a real urn:uuid. */
APIX.TASK_GROUP_UUID = 'urn:uuid:7f3b9d2a-1c84-4e57-bf90-0a1b2c3d4e5f';

APIX.seed = {

  /* ---- Organizations ---------------------------------------------------- */
  applicant: {
    resourceType: 'Organization',
    id: 'org-synthpharma-ag',
    meta: { profile: [APIX.SYS.profile.org] },
    identifier: [{ use: 'official', system: 'urn:oid:2.16.840.1.113883.4.82', value: '150483920' }],
    active: true,
    type: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/organization-type', code: 'other', display: 'Other' }], text: 'Applicant (NDA holder)' }],
    name: 'SynthPharma AG',
    contact: [{
      name: [{ text: 'Dr. John Doe, Head of Regulatory Affairs' }],
      telecom: [{ system: 'email', value: 'john.doe@synthpharma.example', use: 'work' }],
      address: { line: ['123 Synthetic Research Blvd'], city: 'Basel', postalCode: '4000', country: 'Switzerland' }
    }],
    endpoint: [{ reference: 'Endpoint/endpoint-synthpharma' }]
  },

  regulator: {
    resourceType: 'Organization',
    id: 'org-fda-cder-opq',
    name: 'U.S. Food and Drug Administration',
    active: true,
    contact: [{
      name: [{ text: 'Center for Drug Evaluation and Research — Office of Pharmaceutical Quality' }],
      telecom: [{ system: 'email', value: 'opq@fda.example', use: 'work' }],
      address: { type: 'physical', city: 'Silver Spring', state: 'MD', postalCode: '20993', country: 'United States' }
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
    payload: [{
      type: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/endpoint-payload-type', code: 'any', display: 'Any' }] }],
      mimeType: ['application/fhir+json']
    }],
    address: 'https://portal.synthpharma.example/fhir-subscription-notify'
  },

  /* ---- Product context (FHIR R5, NOT APIX-profiled) --------------------- */
  product: {
    resourceType: 'MedicinalProductDefinition',
    id: 'mpd-velexa175',
    identifier: [{ system: 'https://www.fda.gov/drugs/application-number', value: 'NDA 215123' }],
    description: 'Velexa 175 mg film-coated tablets — finished drug product (demo product context).',
    combinedPharmaceuticalDoseForm: { coding: [{ system: 'http://standardterms.edqm.eu', code: '10221000', display: 'Film-coated tablet' }] },
    route: [{ coding: [{ system: 'http://standardterms.edqm.eu', code: '20053000', display: 'Oral use' }] }],
    name: [{
      productName: 'Velexa 175 mg film-coated tablets',
      type: { coding: [{ system: 'http://hl7.org/fhir/uv/pharm-quality/CodeSystem/cs-productNameType-pq-example', code: 'Proprietary', display: 'Proprietary' }] },
      part: [{ part: '175 mg', type: { coding: [{ system: 'http://hl7.org/fhir/medicinal-product-name-part-type', code: 'StrengthPart', display: 'Strength part' }] } }]
    }]
  },

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
    filterBy: [{ resourceType: 'Task', filterParameter: 'identifier', value: APIX.SYS.taskIdSystem + '|' + APIX.TASK_UUID }],
    channelType: { system: APIX.SYS.channelType, code: 'rest-hook' },
    endpoint: 'https://portal.synthpharma.example/fhir-subscription-notify',
    heartbeatPeriod: 300,
    timeout: 5,
    contentType: 'application/fhir+json',
    content: 'full-resource'
  }
};
