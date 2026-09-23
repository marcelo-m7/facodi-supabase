import { handleFacodiMechanism } from '../_shared/facodi-mechanism.ts';

Deno.serve((req) => handleFacodiMechanism(req, {
  functionName: 'v2_push_odoo_learning_object',
  jobType: 'push_odoo_learning_object',
  kind: 'odoo',
}));
