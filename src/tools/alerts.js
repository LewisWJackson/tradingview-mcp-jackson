import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/alerts.js';

export function registerAlertTools(server) {
  server.tool('alert_create', 'Create a price alert on the current chart symbol via the TradingView pricealerts REST API (server-side, pushes to mobile). Alerts require a finite expiration on non-premium plans.', {
    condition: z.string().describe('Alert condition: "crossing", "greater_than", "less_than" (or native API types "cross", "cross_up", "cross_down", "greater", "less")'),
    price: z.coerce.number().describe('Price level for the alert'),
    message: z.string().optional().describe('Alert message'),
    expiration_days: z.coerce.number().optional().describe('Days until the alert expires (default 14; plan may cap this)'),
  }, async ({ condition, price, message, expiration_days }) => {
    try { return jsonResult(await core.create({ condition, price, message, expiration_days })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_list', 'List active alerts', {}, async () => {
    try { return jsonResult(await core.list()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_delete', 'Delete alerts by id (alert_ids from alert_list) or all alerts (delete_all: true) via the pricealerts REST API', {
    delete_all: z.coerce.boolean().optional().describe('Delete all alerts'),
    alert_ids: z.array(z.coerce.number()).optional().describe('Specific alert ids to delete (from alert_list)'),
  }, async ({ delete_all, alert_ids }) => {
    try { return jsonResult(await core.deleteAlerts({ delete_all, alert_ids })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
