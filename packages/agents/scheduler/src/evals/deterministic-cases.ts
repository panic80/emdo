export const schedulerDeterministicEvalCases = Object.freeze([
  Object.freeze({
    id: 'toronto-spring-gap-rejected',
    category: 'timezone',
    input: '2026-03-08T02:30',
    expectedCode: 'nonexistent-local-time',
  }),
  Object.freeze({
    id: 'toronto-fall-overlap-rejected-by-default',
    category: 'timezone',
    input: '2026-11-01T01:30',
    expectedCode: 'ambiguous-local-time',
  }),
  Object.freeze({
    id: 'private-calendar-content-remains-masked',
    category: 'privacy',
    fixture: '../fixtures/private-calendar-evidence.json',
    expectedMaskReason: 'calendar-private',
  }),
  Object.freeze({
    id: 'unrecorded-maps-route-uses-fallback',
    category: 'travel',
    expectedSource: 'fallback',
  }),
  Object.freeze({
    id: 'calendar-create-needs-exact-readback',
    category: 'provider-write',
    fixture: '../fixtures/google-calendar-create-success.json',
    expectedStatus: 'applied',
  }),
]);
