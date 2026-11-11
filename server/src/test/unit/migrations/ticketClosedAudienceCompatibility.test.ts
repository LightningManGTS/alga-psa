import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const migration = require(path.resolve(
  here,
  '..', '..', '..', '..', 'migrations',
  '20261106190000_split_ticket_closed_email_audiences.cjs',
)) as {
  config: { transaction: boolean };
  up: (knex: unknown) => Promise<void>;
  down: (knex: unknown) => Promise<void>;
};

describe('retired ticket-closed audience migration compatibility', () => {
  it('preserves the original transaction setting and does not query or change data', async () => {
    const knex = new Proxy(() => {
      throw new Error('The compatibility migration must not query the database');
    }, {
      get() {
        throw new Error('The compatibility migration must not access the database');
      },
    });

    expect(migration.config.transaction).toBe(false);
    await expect(migration.up(knex)).resolves.toBeUndefined();
    await expect(migration.down(knex)).resolves.toBeUndefined();
  });
});
