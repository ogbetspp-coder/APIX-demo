/*
 * APIX canonical systems + the four APIX CodeSystems, modelled on the real IG
 * (http://hl7.org/fhir/uv/apix). Used for display lookups across the UI.
 */
window.APIX = window.APIX || {};

APIX.SYS = {
  canonical: 'http://hl7.org/fhir/uv/apix',
  taskCode: 'http://hl7.org/fhir/uv/apix/CodeSystem/apix-task-code',
  businessStatus: 'http://hl7.org/fhir/uv/apix/CodeSystem/apix-business-status',
  idType: 'http://hl7.org/fhir/uv/apix/CodeSystem/apix-demo',
  ctd: 'http://hl7.org/fhir/uv/apix/CodeSystem/ctd-section',
  channelType: 'http://terminology.hl7.org/CodeSystem/subscription-channel-type',
  topicStatus: 'http://hl7.org/fhir/uv/example/SubscriptionTopic/TaskStatusChangeWithIdentifierFilter',
  topicCreate: 'http://hl7.org/fhir/uv/example/SubscriptionTopic/TaskCreationWithOrganizationAssignedFilter',
  taskIdSystem: 'http://example.org/health-authority/task-id',
  procedureSystem: 'http://example.org/health-authority/procedure-number',
  profile: {
    task: 'http://hl7.org/fhir/uv/apix/StructureDefinition/apix-task',
    org: 'http://hl7.org/fhir/uv/apix/StructureDefinition/apix-organization',
    docref: 'http://hl7.org/fhir/uv/apix/StructureDefinition/apix-documentreference',
    sub: 'http://hl7.org/fhir/uv/apix/StructureDefinition/apix-subscription'
  }
};

APIX.CS = {
  // Task.code — apix-task-code
  taskCode: {
    'initial-submission': 'Initial Submission',
    'supplement': 'Supplement / Variation',
    'variation-type-ib': 'Type IB Variation',
    'response-to-questions': 'Response to Information Request',
    'information-request': 'List of Questions / Information Request',
    'validation-report': 'Validation Report',
    'approval': 'Approval Letter / Positive Decision',
    'rejection': 'Rejection / Negative Decision'
  },
  // Task.businessStatus — apix-business-status (the regulatory workflow lives here)
  businessStatus: {
    'submitted': 'Submitted',
    'received': 'Received',
    'validation-successful': 'Validation Successful',
    'validation-failed': 'Validation Failed',
    'under-assessment': 'Under Assessment',
    'clock-stop': 'Clock Stop',
    'decision-pending': 'Decision Pending',
    'approved': 'Approved',
    'rejected': 'Rejected'
  },
  // Task.identifier.type — apix-demo
  idType: {
    'apixtaskinstance': 'APIX Task Instance ID',
    'apixregulatorprocedureno': 'APIX Regulator Procedure Number'
  },
  // eCTD module / section codes — ctd-section
  ctd: {
    '1.0': 'Cover Letter',
    'application-form': 'Application Form',
    'variation-application': 'Variation Application Form',
    '3.2.P.5.1': 'Specification - Drug Product',
    '3.2.P.5.4': 'Batch Analyses',
    '3.2.P.5.6': 'Justification of Specification',
    '3.2.P.8.1': 'Stability Summary',
    'acknowledgement-receipt': 'Acknowledgement of Receipt',
    'validation-report': 'Validation Report',
    'approval-letter': 'Approval Letter',
    'assessment-report': 'Assessment Report',
    'm1': 'Module 1',
    'm3': 'Module 3 - Quality'
  }
};

/* Ordered regulatory milestones for the applicant "FedEx-style" tracking timeline. */
APIX.businessStatusFlow = [
  { code: 'submitted',             label: 'Submitted',  icon: '↗' },
  { code: 'received',              label: 'Received',   icon: '✓' },
  { code: 'validation-successful', label: 'Validated',  icon: '✓' },
  { code: 'under-assessment',      label: 'Assessing',  icon: '⚙' },
  { code: 'approved',              label: 'Approved',   icon: '★' }
];

/* Resolve a display string for a code in one of the APIX CodeSystems. */
APIX.display = function (csKey, code) {
  var cs = APIX.CS[csKey] || {};
  return cs[code] || code;
};
