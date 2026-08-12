import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../../drizzle/0003_durable_runtime_repositories.sql',
  import.meta.url,
);

const readMigration = async () =>
  (await readFile(migrationUrl, 'utf8')).toLowerCase().replaceAll('"', '');

describe('proposal approval display persistence', () => {
  it('rejects blank-looking and control-spoofed display text inside PostgreSQL', async () => {
    const sql = await readMigration();
    const textValidator = sql.match(
      /create or replace function emdo\.proposal_approval_display_text_is_safe\([\s\S]+?\$function\$;/u,
    )?.[0];
    const displayValidator = sql.match(
      /create or replace function emdo\.proposal_approval_display_is_valid\([\s\S]+?\$function\$;/u,
    )?.[0];

    expect(textValidator).toBeDefined();
    expect(textValidator).toContain('immutable');
    expect(textValidator).toContain('pg_catalog.ascii');
    expect(textValidator).toMatch(/between 0 and 31/u);
    expect(textValidator).toMatch(/between 127 and 159/u);
    expect(textValidator).toMatch(/between 8234 and 8238/u);
    expect(textValidator).toMatch(/between 8294 and 8303/u);
    expect(textValidator).toMatch(/between 65024 and 65039/u);
    expect(textValidator).toMatch(/between 917760 and 917999/u);
    expect(textValidator).toContain('p_require_visible');
    expect(textValidator).toContain('exists (');
    expect(textValidator).toMatch(/where piece\.value <> ''/u);

    expect(displayValidator).toBeDefined();
    expect(displayValidator).toMatch(
      /proposal_approval_display_text_is_safe\(\s*p_display ->> 'title', true\s*\)/u,
    );
    expect(displayValidator).toMatch(
      /proposal_approval_display_text_is_safe\(\s*p_display ->> 'summary', true\s*\)/u,
    );
    expect(displayValidator).toMatch(
      /proposal_approval_display_text_is_safe\(\s*p_display ->> 'beforesummary', false\s*\)/u,
    );
    expect(displayValidator).toMatch(
      /proposal_approval_display_text_is_safe\(\s*p_display ->> 'aftersummary', false\s*\)/u,
    );
    expect(displayValidator).toMatch(
      /proposal_approval_display_text_is_safe\(\s*field\.value ->> 'label', true\s*\)/u,
    );
    expect(displayValidator).toMatch(
      /proposal_approval_display_text_is_safe\(\s*field\.value ->> 'value', false\s*\)/u,
    );
  });

  it('validates every bounded display field before the immutable proposal row is stored', async () => {
    const sql = await readMigration();
    const validator = sql.match(
      /create or replace function emdo\.proposal_approval_display_is_valid\([\s\S]+?\$function\$;/u,
    )?.[0];

    expect(validator).toBeDefined();
    expect(validator).toContain('immutable');
    expect(validator).toContain('jsonb_array_elements');
    expect(validator).toMatch(/array\[\s*'schemaversion', 'title', 'summary'/u);
    expect(validator).toContain("array['label', 'value']");
    expect(validator).toMatch(
      /json_text_utf16_length\(p_display ->> 'title'\)[\s\S]+between 1 and 200/u,
    );
    expect(validator).toMatch(
      /json_text_utf16_length\(p_display ->> 'summary'\)[\s\S]+between 1 and 1000/u,
    );
    expect(validator).toMatch(
      /json_text_utf16_length\(field\.value ->> 'label'\)[\s\S]+not between 1 and 120/u,
    );
    expect(validator).toMatch(
      /json_text_utf16_length\(field\.value ->> 'value'\)[\s\S]+> 2000/u,
    );
    expect(sql).toMatch(
      /add column approval_display jsonb not null[\s\S]+action_proposals_approval_display_check[\s\S]+proposal_approval_display_is_valid\(approval_display\)/u,
    );
  });
});
