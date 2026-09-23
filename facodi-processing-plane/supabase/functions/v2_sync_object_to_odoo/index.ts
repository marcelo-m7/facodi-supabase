import { handleFacodiMechanism } from '../_shared/facodi-mechanism.ts';

Deno.serve((req) => handleFacodiMechanism(req, {
  functionName: 'v2_sync_object_to_odoo',
  jobType: 'sync_object_to_odoo',
  kind: 'odoo',
}));
