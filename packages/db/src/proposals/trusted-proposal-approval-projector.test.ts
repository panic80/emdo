import { describe, expect, it } from 'vitest';

import {
  TrustedProposalApprovalProjectionError,
  TrustedProposalApprovalSourceSchema,
  projectTrustedProposalApproval,
} from './trusted-proposal-approval-projector.js';

const approvalDisplay = {
  schemaVersion: 1,
  title: 'Create calendar event',
  summary: 'Review a proposed Google Calendar event creation.',
  beforeSummary: '',
  afterSummary: 'Dentist checkup',
  fields: [
    { label: 'Event', value: 'Dentist checkup' },
    { label: 'Starts', value: '2026-08-12T13:00:00.000Z' },
    { label: 'Location', value: 'Clinic' },
  ],
} as const;

describe('projectTrustedProposalApproval', () => {
  it('validates and deeply freezes the exact persisted approval display', () => {
    const result = projectTrustedProposalApproval(approvalDisplay);

    expect(result).toEqual(approvalDisplay);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.fields)).toBe(true);
    expect(Object.isFrozen(result.fields[0])).toBe(true);
    expect(result).not.toBe(approvalDisplay);
    expect(result.fields).not.toBe(approvalDisplay.fields);
  });

  it('preserves hash-bound display bytes without trimming or normalization', () => {
    const input = {
      ...approvalDisplay,
      title: '  إنشاء موعد 📅  ',
      beforeSummary: '  before  ',
      afterSummary: 'סקירת פרטי האירוע ✅',
      fields: [{ label: ' כותרת 🦷 ', value: '  keep spacing  ' }],
    };

    expect(projectTrustedProposalApproval(input)).toEqual(input);
  });

  it.each([
    ['NUL', '\u0000'],
    ['C0 control', '\u001f'],
    ['DEL', '\u007f'],
    ['C1 control', '\u009f'],
    ['Arabic letter mark', '\u061c'],
    ['left-to-right mark', '\u200e'],
    ['right-to-left mark', '\u200f'],
    ['bidi embedding', '\u202a'],
    ['bidi override', '\u202e'],
    ['bidi isolate', '\u2066'],
    ['bidi isolate terminator', '\u2069'],
  ])('rejects unsafe display character %s', (_name, hostile) => {
    const inputs = [
      { ...approvalDisplay, title: `Review${hostile}event` },
      { ...approvalDisplay, beforeSummary: `Before${hostile}` },
      {
        ...approvalDisplay,
        fields: [{ label: 'Title', value: `Dentist${hostile}` }],
      },
    ];

    for (const input of inputs) {
      expect(() => projectTrustedProposalApproval(input)).toThrow(
        expect.objectContaining({
          code: 'invalid-source',
        }) as TrustedProposalApprovalProjectionError,
      );
    }
  });

  it.each([
    'Bearer is the title of this book',
    'The phrase access_token appears in the user note',
    'providerSdkCallId is discussed as plain text',
    'a'.repeat(64),
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature1234567890',
    'ya29.this-is-user-authored-prose',
  ])(
    'allows legitimate display text that resembles secret material: %s',
    (value) => {
      expect(
        projectTrustedProposalApproval({
          ...approvalDisplay,
          afterSummary: value,
          fields: [{ label: 'User-authored note', value }],
        }),
      ).toMatchObject({ afterSummary: value });
    },
  );

  it.each([
    {
      name: 'a raw capability preview source',
      input: {
        capabilityId: 'google-calendar.event.create',
        beforePreview: null,
        afterPreview: { summary: 'Dentist checkup' },
      },
    },
    {
      name: 'a top-level canonical argument sibling',
      input: {
        ...approvalDisplay,
        canonicalArguments: { calendarId: 'primary' },
      },
    },
    {
      name: 'a top-level raw preview sibling',
      input: {
        ...approvalDisplay,
        beforePreview: { oauthAccessToken: 'secret' },
      },
    },
    {
      name: 'an extra field property',
      input: {
        ...approvalDisplay,
        fields: [{ label: 'Event', value: 'Dentist', providerRecord: {} }],
      },
    },
    {
      name: 'a missing schema version',
      input: {
        title: approvalDisplay.title,
        summary: approvalDisplay.summary,
        beforeSummary: approvalDisplay.beforeSummary,
        afterSummary: approvalDisplay.afterSummary,
        fields: approvalDisplay.fields,
      },
    },
    {
      name: 'a future schema version',
      input: { ...approvalDisplay, schemaVersion: 2 },
    },
  ])('rejects $name', ({ input }) => {
    expect(TrustedProposalApprovalSourceSchema.safeParse(input).success).toBe(
      false,
    );
    expect(() => projectTrustedProposalApproval(input)).toThrow(
      expect.objectContaining({
        code: 'invalid-source',
      }) as TrustedProposalApprovalProjectionError,
    );
  });

  it.each([
    ['empty title', { ...approvalDisplay, title: '' }],
    ['oversized title', { ...approvalDisplay, title: 'x'.repeat(201) }],
    ['empty summary', { ...approvalDisplay, summary: '' }],
    ['oversized summary', { ...approvalDisplay, summary: 'x'.repeat(1_001) }],
    [
      'oversized before summary',
      { ...approvalDisplay, beforeSummary: 'x'.repeat(2_001) },
    ],
    [
      'oversized after summary',
      { ...approvalDisplay, afterSummary: 'x'.repeat(2_001) },
    ],
    [
      'too many fields',
      {
        ...approvalDisplay,
        fields: Array.from({ length: 33 }, (_, index) => ({
          label: `Field ${index}`,
          value: '',
        })),
      },
    ],
    [
      'empty field label',
      { ...approvalDisplay, fields: [{ label: '', value: '' }] },
    ],
    [
      'oversized field label',
      {
        ...approvalDisplay,
        fields: [{ label: 'x'.repeat(121), value: '' }],
      },
    ],
    [
      'oversized field value',
      {
        ...approvalDisplay,
        fields: [{ label: 'Note', value: 'x'.repeat(2_001) }],
      },
    ],
  ])('enforces the persisted approval display bound: %s', (_name, input) => {
    expect(() => projectTrustedProposalApproval(input)).toThrow(
      expect.objectContaining({
        code: 'invalid-source',
      }) as TrustedProposalApprovalProjectionError,
    );
  });

  it('allows the exact empty and maximum-size contract boundaries', () => {
    const input = {
      schemaVersion: 1,
      title: 't'.repeat(200),
      summary: 's'.repeat(1_000),
      beforeSummary: '',
      afterSummary: 'a'.repeat(2_000),
      fields: Array.from({ length: 32 }, () => ({
        label: 'l'.repeat(120),
        value: 'v'.repeat(2_000),
      })),
    } as const;

    expect(projectTrustedProposalApproval(input)).toEqual(input);
  });
});
