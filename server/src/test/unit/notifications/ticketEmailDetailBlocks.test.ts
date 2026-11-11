import { readFileSync } from 'node:fs';
import path from 'node:path';
import Handlebars from 'handlebars';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Knex } from 'knex';

const state = vi.hoisted(() => ({
  assets: [] as Record<string, unknown>[],
  materials: [] as Record<string, unknown>[],
  time: [] as Record<string, unknown>[],
  tenant: vi.fn(),
  joins: vi.fn(),
  where: vi.fn(),
  hours: vi.fn(),
}));
vi.mock('@alga-psa/shared/billingClients/hourBlockService', () => ({
  getAvailableHourBlockMinutes: state.hours,
}));
vi.mock('@alga-psa/db', () => ({
  tenantDb: (...args: unknown[]) => {
    state.tenant(...args);
    return {
      tenantJoin: state.joins,
      table: (table: string) => {
        const rows = table.startsWith('asset_') ? state.assets
          : table.startsWith('ticket_materials') ? state.materials : state.time;
        const builder = {
          select: () => builder,
          where: (criteria: unknown) => { state.where(criteria); return builder; },
          orderBy: () => Promise.resolve(rows),
        };
        return builder;
      },
    };
  },
}));
import { buildTicketEmailDetailBlocks, sortTimeEntriesChronologically } from '../../../lib/notifications/ticketEmailDetailBlocks';

const knex = { raw: vi.fn() } as Pick<Knex, 'raw'> as Knex;
const root = path.resolve(__dirname, '../../../../..');
const build = () => buildTicketEmailDetailBlocks(knex, 'tenant-1', 'ticket-1', 'client-1');

describe('closed-ticket email detail data', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.assets = [];
    state.materials = [];
    state.time = [];
    state.hours.mockResolvedValue(765);
  });

  it('returns data and totals without HTML fields, locale lookups or audience filtering', async () => {
    const data = await build();
    expect(data).toEqual({
      assets: [], materials: [], materialsTotal: '', timeEntries: [],
      totalTimeWorked: '0 hrs', totalTimeBillable: '0 hrs', remainingBlockHours: '12 hrs 45 min',
    });
    expect(Object.keys(data).some(key => /Html/.test(key))).toBe(false);
    expect(state.hours).toHaveBeenCalledWith(knex, 'tenant-1', 'client-1');
  });

  it('preserves selectable asset fields as unescaped data', async () => {
    state.assets = [{
      asset_tag: 'A-1', name: '<Printer>', asset_type: 'printer', asset_type_name: 'Printer',
      manufacturer: 'Brother', model: 'HL-L6200DW', serial_number: 'SN-1', status: 'active',
      location: null, relationship_type: 'affected',
    }];
    const data = await build();
    expect(data.assets[0]).toEqual({
      assetTag: 'A-1', name: '<Printer>', assetType: 'Printer', manufacturer: 'Brother',
      model: 'HL-L6200DW', serialNumber: 'SN-1', status: 'active', location: '', relationship: 'affected',
    });
    expect(Handlebars.compile('{{#each assets}}{{name}}{{/each}}')(data)).toBe('&lt;Printer&gt;');
  });

  it('uses row currencies and keeps unlike currency totals separate', async () => {
    state.materials = [
      { item_name: 'Toner', description: 'Black', quantity: '2', rate: '4500', currency_code: 'USD', is_billed: true },
      { item_name: null, description: 'Cable', quantity: 1, rate: 1000, currency_code: 'EUR', is_billed: false },
    ];
    const data = await build();
    expect(data.materials[0]).toMatchObject({ name: 'Toner', quantity: 2, rate: '$45.00', amount: '$90.00', billed: true });
    expect(data.materials[1]).toMatchObject({ name: 'Cable', currencyCode: 'EUR', billed: false });
    expect(data.materialsTotal).toBe('$90.00 + €10.00');
  });

  it('rejects invalid material currency and propagates lookup failures', async () => {
    state.materials = [{ item_name: 'Toner', quantity: 1, rate: 1000, currency_code: 'BAD' }];
    await expect(build()).rejects.toThrow('unsupported material currency');
    state.materials = [];
    state.hours.mockRejectedValueOnce(new Error('Hour-block database unavailable'));
    await expect(build()).rejects.toThrow('Hour-block database unavailable');
  });

  it('renders the old time-table columns from individual chronological array rows', async () => {
    state.time = [
      { entry_id: '3', start_time: '2025-06-11T09:00:00Z', end_time: '2025-06-11T09:30:00Z', billable_duration: 0, technician_name: 'Jane Smith' },
      { entry_id: '2', start_time: '2025-06-10T09:00:00Z', end_time: '2025-06-10T10:00:00Z', billable_duration: 45, technician_name: '<Alex>' },
      { entry_id: '1', start_time: '2025-06-09T09:00:00Z', end_time: '2025-06-09T10:30:00Z', billable_duration: 90, technician_name: 'Jane Smith' },
    ];
    const data = await build();
    expect(data.timeEntries).toEqual([
      { date: '06/09/2025', technician: 'Jane Smith', worked: '1 hr 30 min', billable: '1 hr 30 min' },
      { date: '06/10/2025', technician: '<Alex>', worked: '1 hr', billable: '0 hrs 45 min' },
      { date: '06/11/2025', technician: 'Jane Smith', worked: '0 hrs 30 min', billable: '0 hrs' },
    ]);
    expect(data.totalTimeWorked).toBe('3 hrs');
    expect(data.totalTimeBillable).toBe('2 hrs 15 min');
    const guide = readFileSync(path.join(root, 'docs/email/editing-ticket-email-html.md'), 'utf8');
    const example = guide.match(/```html\r?\n([\s\S]*?)```/)?.[1];
    expect(example).toBeDefined();
    const source = example!.match(/\{\{#if ticket\.timeEntries\}\}[\s\S]*?\{\{\/if\}\}/)?.[0];
    expect(source).toBeDefined();
    const render = Handlebars.compile(source!, { strict: true });
    const html = render({ ticket: data });
    expect(html.match(/<td /g)).toHaveLength(12);
    for (const column of ['Date', 'Technician', 'Worked', 'Billable']) expect(html).toContain(`>${column}</th>`);
    expect(html).toContain('&lt;Alex&gt;');
    expect(html.indexOf('06/09/2025')).toBeLessThan(html.indexOf('06/10/2025'));
    expect(html.indexOf('06/10/2025')).toBeLessThan(html.indexOf('06/11/2025'));
    expect(render({ ticket: { ...data, timeEntries: [] } })).not.toContain('<table');
  });

  it('uses the existing effective timezone for the work date', async () => {
    state.time = [{ entry_id: '1', start_time: '2025-06-10T01:00:00Z', end_time: '2025-06-10T02:00:00Z', billable_duration: null, technician_name: null }];
    const data = await buildTicketEmailDetailBlocks(knex, 'tenant-1', 'ticket-1', null, 'America/New_York');
    expect(data.timeEntries[0].date).toBe('06/09/2025');
    expect(data.remainingBlockHours).toBe('0 hrs');
    expect(state.hours).not.toHaveBeenCalled();
  });

  it('keeps sorting deterministic without mutating input', () => {
    const rows = ['B', 'A'].map(name => ({
      entry_id: name, technician_name: name, start_time: '2025-06-10T09:00:00Z',
      end_time: null, billable_duration: 0,
    }));
    expect(sortTimeEntriesChronologically(rows).map(row => row.entry_id)).toEqual(['A', 'B']);
    expect(rows[0].entry_id).toBe('B');
  });

  it('scopes every query and join and wires details only into closed notifications', async () => {
    await build();
    expect(state.tenant).toHaveBeenCalledTimes(3);
    for (const call of state.tenant.mock.calls) expect(call).toEqual([knex, 'tenant-1']);
    expect(state.joins.mock.calls.map(call => call[1])).toEqual(['assets as a', 'asset_type_registry as atr', 'service_catalog as sc', 'users as u']);
    expect(state.where).toHaveBeenCalledWith({ 'te.work_item_id': 'ticket-1', 'te.work_item_type': 'ticket' });
    const source = readFileSync(path.join(root, 'server/src/lib/eventBus/subscribers/ticketEmailSubscriber.ts'), 'utf8');
    const beforeClosed = source.slice(0, source.indexOf('async function handleTicketClosed('));
    expect(beforeClosed.match(/await buildTicketEmailDetailBlocks/g)).toBeNull();
    expect(source.match(/await buildTicketEmailDetailBlocks/g)).toHaveLength(2);
    expect(source).toContain('db, tenantId, child.ticket_id, child.client_id, emailTimeZone');
    expect(source).not.toContain("template: 'ticket-closed-client'");
    expect(source).not.toContain("template: 'ticket-closed-internal'");
  });
});
