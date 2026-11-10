/**
 * Pre-rendered ticket-detail blocks for ticket emails (assets, materials, time
 * usage, remaining prepaid hour-block balance).
 *
 * The `*Html` blocks are convenience tables with fixed columns: column headers,
 * relationship labels, Yes/No, duration units, dates and money are localized to
 * the email locale. The layout is fixed, but the borders and header color follow
 * the tenant's applied email-branding palette (stock palette when none is
 * applied), so the tables match branded templates. Templates that need their
 * own markup should iterate `ticket.assets` instead.
 *
 * Time and materials tables carry technician names, non-billable time, material
 * rates and billed state, so they are internal-only. Callers that build a
 * customer-facing context must pass the blocks through
 * `clientFacingDetailBlocks()`. The client copy of the Ticket Closed email is
 * the one exception: `closedClientDetailBlocks()` keeps the time table (so the
 * customer sees who worked when, and what was billable) but still drops the
 * materials blocks.
 *
 * Time rows are listed oldest first by the entry's work date (`start_time`,
 * which carries the chosen date for back-dated entries), then technician, so
 * several entries by one or more technicians read as a timeline.
 *
 * Variable-name contract is documented in
 * `docs/plans/2026-07-17-email-template-variables-inventory.json` (ticket-closed-client
 * and ticket-closed-internal).
 */

import type { Knex } from 'knex';
import { tenantDb } from '@alga-psa/db';
import {
  formatCurrencyFromMinorUnits,
  formatMinutesAsHoursAndMinutes,
  isSupportedCurrency,
  workedMinutes,
  type DurationLabels,
} from '@alga-psa/core';
import { LOCALE_CONFIG, normalizeLocale, type SupportedLocale } from '@alga-psa/core/i18n/config';
import { SYSTEM_DATE_FORMAT, type CountryDateFormat } from '@alga-psa/core/i18n/countryDateFormat';
import logger from '@alga-psa/core/logger';
import { getAvailableHourBlockMinutes } from '@alga-psa/shared/billingClients/hourBlockService';
import { formatDateValue } from '@alga-psa/ui/lib/i18n/formatDateValue';
import {
  STOCK_EMAIL_PALETTE,
  isHexColor,
  normalizeHex,
  type EmailPaletteTokens,
} from '@alga-psa/email/branding';

export interface TicketEmailDetailBlocks {
  assets: TicketEmailAsset[];
  /** HTML table of associated assets, headers localized; '' when the ticket has none. */
  assetsHtml: string;
  /** Internal only. HTML table of materials/services used, localized; '' when none. */
  materialsHtml: string;
  /** Internal only. Money-formatted total of all material line amounts; '' when none. */
  materialsTotal: string;
  /**
   * HTML table of time entries (date, technician, worked, billable), oldest
   * first, localized; '' when none. Internal emails and the closed-client email
   * only.
   */
  timeHtml: string;
  /**
   * Plain-text counterpart of `timeHtml` (same rows, order and formatting) for
   * text email bodies, which must never carry HTML. Same audience as `timeHtml`.
   */
  timeEntries: TicketEmailTimeEntry[];
  /** Sum of worked minutes across the ticket's time entries, formatted. */
  totalTimeWorked: string;
  /** Sum of billable_duration across the ticket's time entries, formatted. */
  totalTimeBillable: string;
  /** Client's available prepaid hour-block minutes at send time, formatted. */
  remainingBlockHours: string;
}

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
  quantity: number | string | null;
  rate: number | string | null;
  currency_code: string | null;
  is_billed: boolean | null;
}

export interface TimeEntryRow {
  entry_id: string;
  start_time: Date | string | null;
  end_time: Date | string | null;
  billable_duration: number | string | null;
  technician_name: string | null;
}

/**
 * HTML-escape a string for safe interpolation into the email body.
 * Mirrors the subscriber's private escapeHtml convention.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeString(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).trim();
}

function toNumberOrNull(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

const DETAIL_TABLE_STYLE = 'border-collapse:collapse;width:100%;margin:0;font-size:13px;';
// Body text is a neutral, non-palette color so it stays readable on any card.
const DETAIL_TEXT_COLOR = '#1f2933';

interface DetailTableStyles {
  th: string;
  td: string;
}

// Stock-palette rendering, mirrored by the variable registry examples.
export const DETAIL_TH_STYLE = 'text-align:left;padding:6px 10px;border-bottom:2px solid #e4ddff;font-weight:600;color:#5b38b0;white-space:nowrap;';
export const DETAIL_TD_STYLE = 'padding:6px 10px;border-bottom:1px solid #e6deff;color:#1f2933;word-break:break-word;';

// Header text and rules follow the tenant's applied email-branding palette
// (dark, cardBorder, infoBoxBorder), matching the template chrome around them.
export function detailTableStyles(palette: EmailPaletteTokens): DetailTableStyles {
  return {
    th: `text-align:left;padding:6px 10px;border-bottom:2px solid ${palette.cardBorder};font-weight:600;color:${palette.dark};white-space:nowrap;`,
    td: `padding:6px 10px;border-bottom:1px solid ${palette.infoBoxBorder};color:${DETAIL_TEXT_COLOR};word-break:break-word;`,
  };
}

const HEX_PALETTE_TOKENS = [
  'primary',
  'secondary',
  'dark',
  'outerBg',
  'footerBg',
  'cardBorder',
  'infoBoxBg',
  'infoBoxBorder',
] as const satisfies ReadonlyArray<keyof EmailPaletteTokens>;

// Free-form CSS values; rejected if they could break out of a style attribute.
const CSS_PALETTE_TOKENS = ['gradient', 'cardShadow', 'badgeBg'] as const satisfies ReadonlyArray<keyof EmailPaletteTokens>;

function isSafeCssValue(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && !/[<>"';{}]/.test(value);
}

/**
 * Resolve the palette for the pre-rendered tables from `tenant_settings.settings`.
 * Uses `emailBranding.appliedPalette` (set once a palette has been applied to
 * the templates); invalid or missing tokens fall back to the stock palette.
 */
export function resolveDetailBlockPalette(settings: unknown): EmailPaletteTokens {
  const applied = (settings as { emailBranding?: { appliedPalette?: unknown } } | null | undefined)
    ?.emailBranding?.appliedPalette;
  if (!applied || typeof applied !== 'object') {
    return STOCK_EMAIL_PALETTE;
  }
  const source = applied as Record<string, unknown>;
  const palette: EmailPaletteTokens = { ...STOCK_EMAIL_PALETTE };
  for (const token of HEX_PALETTE_TOKENS) {
    const value = source[token];
    if (isHexColor(value)) {
      palette[token] = normalizeHex(value) ?? palette[token];
    }
  }
  for (const token of CSS_PALETTE_TOKENS) {
    const value = source[token];
    if (isSafeCssValue(value)) {
      palette[token] = value.trim();
    }
  }
  return palette;
}

/** Read the tenant's applied email-branding palette for the detail tables. */
export async function loadDetailBlockPalette(
  db: Knex | Knex.Transaction,
  tenantId: string,
): Promise<EmailPaletteTokens> {
  const row = await tenantDb(db, tenantId)
    .table('tenant_settings')
    .first<{ settings?: unknown } | undefined>('settings');
  return resolveDetailBlockPalette(row?.settings);
}

/**
 * Render a fixed-layout table. `cells` are pre-escaped (or trusted-safe) HTML
 * strings; returns '' when there are no data rows so templates can guard.
 */
function renderTable(headers: string[], rows: string[][], styles: DetailTableStyles): string {
  if (rows.length === 0) {
    return '';
  }
  const headerHtml = headers.map((header) => `<th style="${styles.th}">${escapeHtml(header)}</th>`).join('');
  const bodyHtml = rows
    .map((row) => `<tr>${row.map((cell) => `<td style="${styles.td}">${cell}</td>`).join('')}</tr>`)
    .join('');
  return `<table style="${DETAIL_TABLE_STYLE}"><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`;
}

const EMAIL_DETAIL_NAMESPACE = 'email';

interface DetailLabels {
  assetTag: string;
  name: string;
  serialNumber: string;
  status: string;
  relationship: string;
  affected: string;
  related: string;
  item: string;
  quantity: string;
  rate: string;
  amount: string;
  billed: string;
  yes: string;
  no: string;
  material: string;
  technician: string;
  date: string;
  worked: string;
  billable: string;
  unknown: string;
  duration: DurationLabels;
}

async function loadDetailLabels(locale: SupportedLocale): Promise<DetailLabels> {
  const { getServerTranslation } = await import('@alga-psa/ui/lib/i18n/serverOnly');
  const { t, i18n } = await getServerTranslation(locale, EMAIL_DETAIL_NAMESPACE);
  if (!i18n.hasResourceBundle(locale, EMAIL_DETAIL_NAMESPACE)) {
    throw new Error(`Missing ${EMAIL_DETAIL_NAMESPACE} translations for locale ${locale}`);
  }
  const translate = (key: string): string => {
    if (typeof i18n.getResource(locale, EMAIL_DETAIL_NAMESPACE, key) !== 'string') {
      throw new Error(`Missing ${EMAIL_DETAIL_NAMESPACE} translation: ${key}`);
    }
    return String(t(key));
  };
  return {
    assetTag: translate('ticketDetails.assets.columns.assetTag'),
    name: translate('ticketDetails.assets.columns.name'),
    serialNumber: translate('ticketDetails.assets.columns.serialNumber'),
    status: translate('ticketDetails.assets.columns.status'),
    relationship: translate('ticketDetails.assets.columns.relationship'),
    affected: translate('ticketDetails.relationship.affected'),
    related: translate('ticketDetails.relationship.related'),
    item: translate('ticketDetails.materials.columns.item'),
    quantity: translate('ticketDetails.materials.columns.quantity'),
    rate: translate('ticketDetails.materials.columns.rate'),
    amount: translate('ticketDetails.materials.columns.amount'),
    billed: translate('ticketDetails.materials.columns.billed'),
    yes: translate('ticketDetails.yes'),
    no: translate('ticketDetails.no'),
    material: translate('ticketDetails.materials.fallback'),
    technician: translate('ticketDetails.time.columns.technician'),
    date: translate('ticketDetails.time.columns.date'),
    worked: translate('ticketDetails.time.columns.worked'),
    billable: translate('ticketDetails.time.columns.billable'),
    unknown: translate('ticketDetails.time.unknownTechnician'),
    duration: {
      hr: translate('ticketDetails.duration.hr'),
      hrs: translate('ticketDetails.duration.hrs'),
      min: translate('ticketDetails.duration.min'),
    },
  };
}

/**
 * Format a money amount stored in cents with the row's currency code.
 * Without a usable currency code the amount renders as a plain localized number.
 */
export function formatCentsAmount(
  cents: number,
  currencyCode: string | null | undefined,
  locale: string = LOCALE_CONFIG.defaultLocale,
): string {
  const intlLocale = normalizeLocale(locale) ?? LOCALE_CONFIG.defaultLocale;
  const code = safeString(currencyCode).toUpperCase();
  if (isSupportedCurrency(code)) {
    return formatCurrencyFromMinorUnits(cents, intlLocale, code);
  }
  logger.warn('[TicketEmailDetailBlocks] Missing or unsupported currency code; rendering an unlabelled amount', { currencyCode: code });
  return new Intl.NumberFormat(intlLocale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100);
}

function formatEntryDate(
  value: Date | string | null,
  timeZone: string,
  locale: string,
  dateFormat: CountryDateFormat,
): string {
  if (!value) {
    return '';
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  // Date only; numeric parts let the country format pick the order (US: mm/dd/yyyy).
  return formatDateValue(date, locale, {
    timeZone,
    month: '2-digit',
    day: '2-digit',
    year: 'numeric',
  }, dateFormat);
}

function entryTimestamp(value: Date | string | null): number {
  if (!value) {
    return Number.POSITIVE_INFINITY;
  }
  const time = (value instanceof Date ? value : new Date(value)).getTime();
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
}

/**
 * Chronological order by the entry's work date (`start_time`, which carries the
 * chosen date for back-dated entries), then technician, then entry id, so
 * multiple techs and multiple entries per tech always render deterministically.
 */
export function sortTimeEntriesChronologically(rows: TimeEntryRow[]): TimeEntryRow[] {
  return [...rows].sort((a, b) => {
    const byTime = entryTimestamp(a.start_time) - entryTimestamp(b.start_time);
    if (byTime !== 0 && !Number.isNaN(byTime)) {
      return byTime;
    }
    const byTech = safeString(a.technician_name).localeCompare(safeString(b.technician_name));
    if (byTech !== 0) {
      return byTech;
    }
    return safeString(a.entry_id).localeCompare(safeString(b.entry_id));
  });
}

function relationshipLabel(type: string | null | undefined, labels: DetailLabels): string {
  const value = safeString(type);
  if (value === 'affected') return labels.affected;
  if (value === 'related') return labels.related;
  return value;
}

async function fetchTicketAssets(db: Knex, tenantId: string, ticketId: string): Promise<AssetRow[]> {
  const dbScoped = tenantDb(db, tenantId);
  const query = dbScoped.table('asset_associations as aa')
    .select(
      'a.asset_tag',
      'a.name',
      'a.asset_type',
      'atr.name as asset_type_name',
      'a.manufacturer',
      'a.model',
      'a.serial_number',
      'a.status',
      'a.location',
      'aa.relationship_type'
    );
  dbScoped.tenantJoin(query, 'assets as a', 'aa.asset_id', 'a.asset_id');
  dbScoped.tenantJoin(query, 'asset_type_registry as atr', 'a.asset_type', 'atr.slug', { type: 'left' });
  return query
    .where({ 'aa.entity_id': ticketId, 'aa.entity_type': 'ticket' })
    .orderBy('a.asset_tag', 'asc');
}

async function fetchTicketMaterials(db: Knex, tenantId: string, ticketId: string): Promise<MaterialRow[]> {
  const dbScoped = tenantDb(db, tenantId);
  const query = dbScoped.table('ticket_materials as tm')
    .select(
      'sc.service_name as item_name',
      'tm.description',
      'tm.quantity',
      'tm.rate',
      'tm.currency_code',
      'tm.is_billed'
    );
  dbScoped.tenantJoin(query, 'service_catalog as sc', 'tm.service_id', 'sc.service_id', { type: 'left' });
  return query
    .where({ 'tm.ticket_id': ticketId })
    .orderBy('tm.created_at', 'asc');
}

async function fetchTicketTimeEntries(db: Knex, tenantId: string, ticketId: string): Promise<TimeEntryRow[]> {
  const dbScoped = tenantDb(db, tenantId);
  const query = dbScoped.table('time_entries as te')
    .select(
      'te.entry_id',
      'te.start_time',
      'te.end_time',
      'te.billable_duration',
      db.raw("TRIM(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, ''))) as technician_name")
    );
  dbScoped.tenantJoin(query, 'users as u', 'te.user_id', 'u.user_id', { type: 'left' });
  return query
    .where({ 'te.work_item_id': ticketId, 'te.work_item_type': 'ticket' })
    .orderBy([
      { column: 'te.start_time', order: 'asc' },
      { column: 'te.entry_id', order: 'asc' },
    ]);
}

function renderAssetsTable(rows: AssetRow[], labels: DetailLabels, styles: DetailTableStyles): string {
  return renderTable(
    [labels.assetTag, labels.name, labels.serialNumber, labels.status, labels.relationship],
    rows.map((row) => [
      escapeHtml(safeString(row.asset_tag) || '—'),
      escapeHtml(safeString(row.name) || '—'),
      escapeHtml(safeString(row.serial_number) || '—'),
      escapeHtml(safeString(row.status) || '—'),
      escapeHtml(relationshipLabel(safeString(row.relationship_type), labels) || '—'),
    ]),
    styles,
  );
}

function renderMaterialsTable(
  rows: MaterialRow[],
  locale: string,
  labels: DetailLabels,
  styles: DetailTableStyles,
): string {
  return renderTable(
    [labels.item, labels.quantity, labels.rate, labels.amount, labels.billed],
    rows.map((row) => {
      const quantity = toNumberOrNull(row.quantity) ?? 0;
      const rate = toNumberOrNull(row.rate) ?? 0;
      const currency = row.currency_code;
      const label = safeString(row.item_name) || safeString(row.description) || labels.material;
      return [
        escapeHtml(label),
        escapeHtml(new Intl.NumberFormat(locale, { maximumFractionDigits: 6 }).format(quantity)),
        escapeHtml(formatCentsAmount(rate, currency, locale)),
        escapeHtml(formatCentsAmount(rate * quantity, currency, locale)),
        escapeHtml(row.is_billed ? labels.yes : labels.no),
      ];
    }),
    styles,
  );
}

// Grouped per currency so mixed-currency tickets never sum across currencies.
function formatMaterialsTotal(rows: MaterialRow[], locale: string): string {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const quantity = toNumberOrNull(row.quantity) ?? 0;
    const rate = toNumberOrNull(row.rate) ?? 0;
    const code = safeString(row.currency_code).toUpperCase();
    totals.set(code, (totals.get(code) ?? 0) + rate * quantity);
  }
  return Array.from(totals.entries())
    .map(([code, cents]) => formatCentsAmount(cents, code || null, locale))
    .join(' + ');
}

function formatTimeEntries(
  rows: TimeEntryRow[],
  timeZone: string,
  locale: string,
  labels: DetailLabels,
  dateFormat: CountryDateFormat,
): TicketEmailTimeEntry[] {
  return sortTimeEntriesChronologically(rows).map((row) => ({
    date: formatEntryDate(row.start_time, timeZone, locale, dateFormat) || '—',
    technician: safeString(row.technician_name) || labels.unknown,
    worked: formatMinutesAsHoursAndMinutes(workedMinutes(row), labels.duration),
    billable: formatMinutesAsHoursAndMinutes(toNumberOrNull(row.billable_duration) ?? 0, labels.duration),
  }));
}

function renderTimeTable(entries: TicketEmailTimeEntry[], labels: DetailLabels, styles: DetailTableStyles): string {
  return renderTable(
    [labels.date, labels.technician, labels.worked, labels.billable],
    entries.map((entry) => [
      escapeHtml(entry.date),
      escapeHtml(entry.technician),
      escapeHtml(entry.worked),
      escapeHtml(entry.billable),
    ]),
    styles,
  );
}

/** All-empty blocks, used when the detail lookup fails so the base email still sends. */
export function emptyTicketEmailDetailBlocks(): TicketEmailDetailBlocks {
  return {
    assets: [],
    assetsHtml: '',
    materialsHtml: '',
    materialsTotal: '',
    timeHtml: '',
    timeEntries: [],
    totalTimeWorked: '',
    totalTimeBillable: '',
    remainingBlockHours: '',
  };
}

/** Strips internal-only data (technician time rows, material rates) for customer-facing emails. */
export function clientFacingDetailBlocks(blocks: TicketEmailDetailBlocks): TicketEmailDetailBlocks {
  return { ...blocks, timeHtml: '', timeEntries: [], materialsHtml: '', materialsTotal: '' };
}

/**
 * Blocks for the client copy of the Ticket Closed email. The closed summary is
 * the one customer-facing email that shows the time table (date, technician,
 * worked, billable) alongside the totals; material rates stay internal.
 */
export function closedClientDetailBlocks(blocks: TicketEmailDetailBlocks): TicketEmailDetailBlocks {
  return { ...blocks, materialsHtml: '', materialsTotal: '' };
}

/**
 * Build the ticket-detail email blocks for one ticket.
 *
 * `clientId` may be null/empty, in which case remaining hours are zero.
 * Remaining hours reflect live `hour_blocks.remaining_minutes` at send time
 * (even-time usage already deducted, invoicing state irrelevant).
 */
export async function buildTicketEmailDetailBlocks(
  db: Knex,
  tenantId: string,
  ticketId: string,
  clientId: string | null | undefined,
  timeZone: string = 'UTC',
  locale: string = LOCALE_CONFIG.defaultLocale,
  dateFormat: CountryDateFormat = SYSTEM_DATE_FORMAT,
  palette: EmailPaletteTokens = STOCK_EMAIL_PALETTE,
): Promise<TicketEmailDetailBlocks> {
  if (!ticketId) {
    throw new Error('buildTicketEmailDetailBlocks: ticketId is required');
  }
  const resolvedLocale = normalizeLocale(locale) ?? LOCALE_CONFIG.defaultLocale;
  const labels = await loadDetailLabels(resolvedLocale);
  const styles = detailTableStyles(palette);

  const scopedClientId = clientId ? safeString(clientId) : '';
  const [assetRows, materialRows, timeRows, remainingMinutes] = await Promise.all([
    fetchTicketAssets(db, tenantId, ticketId),
    fetchTicketMaterials(db, tenantId, ticketId),
    fetchTicketTimeEntries(db, tenantId, ticketId),
    scopedClientId ? getAvailableHourBlockMinutes(db, tenantId, scopedClientId) : Promise.resolve(0),
  ]);

  // One time-entry query feeds the totals, timeEntries and timeHtml, so a
  // template using both the totals and the table costs no extra lookups.
  let totalMinutes = 0;
  let billableMinutes = 0;
  for (const row of timeRows) {
    totalMinutes += workedMinutes(row);
    billableMinutes += toNumberOrNull(row.billable_duration) ?? 0;
  }
  const timeEntries = formatTimeEntries(timeRows, timeZone, resolvedLocale, labels, dateFormat);

  return {
    assets: assetRows.map((row) => ({
      assetTag: safeString(row.asset_tag),
      name: safeString(row.name),
      assetType: safeString(row.asset_type_name) || safeString(row.asset_type),
      manufacturer: safeString(row.manufacturer),
      model: safeString(row.model),
      serialNumber: safeString(row.serial_number),
      status: safeString(row.status),
      location: safeString(row.location),
      relationship: relationshipLabel(safeString(row.relationship_type), labels),
    })),
    assetsHtml: renderAssetsTable(assetRows, labels, styles),
    materialsHtml: renderMaterialsTable(materialRows, resolvedLocale, labels, styles),
    materialsTotal: formatMaterialsTotal(materialRows, resolvedLocale),
    timeHtml: renderTimeTable(timeEntries, labels, styles),
    timeEntries,
    totalTimeWorked: formatMinutesAsHoursAndMinutes(totalMinutes, labels.duration),
    totalTimeBillable: formatMinutesAsHoursAndMinutes(billableMinutes, labels.duration),
    remainingBlockHours: formatMinutesAsHoursAndMinutes(remainingMinutes, labels.duration),
  };
}
