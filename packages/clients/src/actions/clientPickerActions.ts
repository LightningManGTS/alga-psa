'use server';

import { createTenantKnex } from '@alga-psa/db';
import { withAuth } from '@alga-psa/auth';
import { assertMspPermission } from '../lib/authHelpers';
import { attachDisplayTags } from '../lib/displayTags';
import type { IDisplayTag } from '@alga-psa/types';
import {
  searchClientsForPicker as searchClientsForPickerModel,
  type PickerClient as SharedPickerClient,
  type SearchClientsForPickerParams,
} from '@alga-psa/shared/ticketClients/clientPicker';

export type {
  SearchClientsForPickerParams,
} from '@alga-psa/shared/ticketClients/clientPicker';

export interface PickerClient extends SharedPickerClient {
  displayTags: IDisplayTag[];
}

export interface SearchClientsForPickerResult {
  clients: PickerClient[];
  total: number;
}

export const searchClientsForPicker = withAuth(async (
  user,
  { tenant },
  params: SearchClientsForPickerParams = {}
): Promise<SearchClientsForPickerResult> => {
  await assertMspPermission(user, 'client', 'read', 'Permission denied: Cannot read clients');

  const { knex: db } = await createTenantKnex();
  const result = await searchClientsForPickerModel(db, tenant, user, params);
  const clients = await attachDisplayTags(db, tenant, user, 'client', result.clients, (client) => client.client_id);
  return { ...result, clients };
});
