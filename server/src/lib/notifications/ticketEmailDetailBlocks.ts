import type { Knex } from 'knex';
import { tenantDb } from '@alga-psa/db';
import {
  formatCurrencyFromMinorUnits,
  formatMinutesAsHoursAndMinutes,
  isSupportedCurrency,
  workedMinutes,
} from '@alga-psa/core';
import { getAvailableHourBlockMinutes } from '@alga-psa/shared/billingClients/hourBlockService';
import { LOCALE_CONFIG } from '@alga-psa/core/i18n/config';

export interface TicketEmailAsset {
  assetTag: string;
  name: string;
  assetType: string;
  manufacturer: string;
  model: string;
  serialNumber: string;
  status: string;
  location: string;
  relationship: string;
}

export interface TicketEmailTimeEntry {
  date: string;
  technician: string;
  worked: string;
  billable: string;
}

export interface TicketEmailMaterial {
  name: string;
  description: string;
  quantity: number;
  rate: string;
  amount: string;
  currencyCode: string;
  billed: boolean;
}

export interface TicketEmailDetailBlocks {
  assets: TicketEmailAsset[];
  materials: TicketEmailMaterial[];
  materialsTotal: string;
  timeEntries: TicketEmailTimeEntry[];
  totalTimeWorked: string;
  totalTimeBillable: string;
  remainingBlockHours: string;
}

interface AssetRow {
  asset_tag: string | null;
  name: string | null;
  asset_type: string | null;
  asset_type_name: string | null;
  manufacturer: string | null;
  model: string | null;
  serial_number: string | null;
  status: string | null;
  location: string | null;
  relationship_type: string | null;
}

interface MaterialRow {
  item_name: string | null;
  description: string | null;
  quantity: number | string;
  rate: number | string;
  currency_code: string;
  is_billed: boolean;
}

export interface TimeEntryRow {
  entry_id: string;
  start_time: Date | string | null;
  end_time: Date | string | null;
  billable_duration: number | string | null;
  technician_name: string | null;
}

function text(value: string | null | undefined): string {
  return value?.trim() ?? '';
}

function number(value: number | string, field: string): number {
  const parsed = typeof value === 'string' && value.trim() === '' ? NaN : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Ticket email details: ${field} must be a finite number`);
  }
  return parsed;
}

function money(amount: number, currencyCode: string): string {
  if (!isSupportedCurrency(currencyCode)) {
    throw new Error(`Ticket email details: unsupported material currency "${currencyCode}"`);
  }
  return formatCurrencyFromMinorUnits(amount, LOCALE_CONFIG.defaultLocale, currencyCode);
}

function timestamp(value: Date | string | null): number {
  if (value === null) return Number.POSITIVE_INFINITY;
  const parsed = new Date(value).getTime();
  if (!Number.isFinite(parsed)) {
    throw new Error('Ticket email details: invalid time-entry work date');
  }
  return parsed;
}

export function sortTimeEntriesChronologically(rows: TimeEntryRow[]): TimeEntryRow[] {
  return [...rows].sort((a, b) => {
    const difference = timestamp(a.start_time) - timestamp(b.start_time);
    if (difference && !Number.isNaN(difference)) return difference;
    return text(a.technician_name).localeCompare(text(b.technician_name))
      || a.entry_id.localeCompare(b.entry_id);
  });
}

async function fetchAssets(knex: Knex, tenant: string, ticketId: string): Promise<AssetRow[]> {
  const db = tenantDb(knex, tenant);
  const query = db.table('asset_associations as aa').select(
    'a.asset_tag', 'a.name', 'a.asset_type', 'atr.name as asset_type_name',
    'a.manufacturer', 'a.model', 'a.serial_number', 'a.status', 'a.location',
    'aa.relationship_type',
  );
  db.tenantJoin(query, 'assets as a', 'aa.asset_id', 'a.asset_id');
  db.tenantJoin(query, 'asset_type_registry as atr', 'a.asset_type', 'atr.slug', { type: 'left' });
  return query.where({ 'aa.entity_id': ticketId, 'aa.entity_type': 'ticket' })
    .orderBy('a.asset_tag', 'asc');
}

async function fetchMaterials(knex: Knex, tenant: string, ticketId: string): Promise<MaterialRow[]> {
  const db = tenantDb(knex, tenant);
  const query = db.table('ticket_materials as tm').select(
    'sc.service_name as item_name', 'tm.description', 'tm.quantity',
    'tm.rate', 'tm.currency_code', 'tm.is_billed',
  );
  db.tenantJoin(query, 'service_catalog as sc', 'tm.service_id', 'sc.service_id', { type: 'left' });
  return query.where({ 'tm.ticket_id': ticketId }).orderBy('tm.created_at', 'asc');
}

async function fetchTimeEntries(knex: Knex, tenant: string, ticketId: string): Promise<TimeEntryRow[]> {
  const db = tenantDb(knex, tenant);
  const query = db.table('time_entries as te').select(
    'te.entry_id', 'te.start_time', 'te.end_time', 'te.billable_duration',
    knex.raw("TRIM(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, ''))) as technician_name"),
  );
  db.tenantJoin(query, 'users as u', 'te.user_id', 'u.user_id', { type: 'left' });
  return query.where({ 'te.work_item_id': ticketId, 'te.work_item_type': 'ticket' })
    .orderBy([{ column: 'te.start_time', order: 'asc' }, { column: 'te.entry_id', order: 'asc' }]);
}

/** Data only: templates own their markup, column selection and labels. */
export async function buildTicketEmailDetailBlocks(
  knex: Knex,
  tenant: string,
  ticketId: string,
  clientId: string | null | undefined,
  timeZone = 'UTC',
): Promise<TicketEmailDetailBlocks> {
  if (!tenant || !ticketId) {
    throw new Error('Ticket email details require a tenant and ticket ID');
  }
  const dateFormatter = new Intl.DateTimeFormat(LOCALE_CONFIG.defaultLocale, {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const [assetRows, materialRows, timeRows, remainingMinutes] = await Promise.all([
    fetchAssets(knex, tenant, ticketId),
    fetchMaterials(knex, tenant, ticketId),
    fetchTimeEntries(knex, tenant, ticketId),
    clientId ? getAvailableHourBlockMinutes(knex, tenant, clientId) : Promise.resolve(0),
  ]);
  const totalsByCurrency = new Map<string, number>();
  const materials = materialRows.map((row) => {
    const quantity = number(row.quantity, 'material quantity');
    const rate = number(row.rate, 'material rate');
    const amount = quantity * rate;
    const currencyCode = text(row.currency_code).toUpperCase();
    totalsByCurrency.set(currencyCode, (totalsByCurrency.get(currencyCode) ?? 0) + amount);
    return {
      name: text(row.item_name) || text(row.description),
      description: text(row.description),
      quantity,
      rate: money(rate, currencyCode),
      amount: money(amount, currencyCode),
      currencyCode,
      billed: row.is_billed,
    };
  });
  let totalWorked = 0;
  let totalBillable = 0;
  const timeEntries = sortTimeEntriesChronologically(timeRows).map((row) => {
    const worked = workedMinutes(row);
    const billable = number(row.billable_duration ?? 0, 'billable duration');
    totalWorked += worked;
    totalBillable += billable;
    return {
      date: row.start_time === null ? '' : dateFormatter.format(new Date(row.start_time)),
      technician: text(row.technician_name),
      worked: formatMinutesAsHoursAndMinutes(worked),
      billable: formatMinutesAsHoursAndMinutes(billable),
    };
  });
  return {
    assets: assetRows.map((row) => ({
      assetTag: text(row.asset_tag),
      name: text(row.name),
      assetType: text(row.asset_type_name) || text(row.asset_type),
      manufacturer: text(row.manufacturer),
      model: text(row.model),
      serialNumber: text(row.serial_number),
      status: text(row.status),
      location: text(row.location),
      relationship: text(row.relationship_type),
    })),
    materials,
    materialsTotal: [...totalsByCurrency].map(([currency, amount]) => money(amount, currency)).join(' + '),
    timeEntries,
    totalTimeWorked: formatMinutesAsHoursAndMinutes(totalWorked),
    totalTimeBillable: formatMinutesAsHoursAndMinutes(totalBillable),
    remainingBlockHours: formatMinutesAsHoursAndMinutes(remainingMinutes),
  };
}
