import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/alerts.js';

export function registerAlertTools(server) {
  server.tool('alert_create', 'Create a price alert via the TradingView alert dialog', {
    condition: z.string().describe('Alert condition (e.g., "crossing", "crossing_up", "crossing_down", "greater_than", "less_than")'),
    price: z.coerce.number().describe('Price level for the alert'),
    message: z.string().optional().describe('Alert message'),
    mobile_push: z.coerce.boolean().optional().default(true).describe('Send app/push notification (default: true)'),
  }, async ({ condition, price, message, mobile_push }) => {
    try { return jsonResult(await core.create({ condition, price, message, mobile_push })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_list', 'List active alerts', {}, async () => {
    try { return jsonResult(await core.list()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_delete', 'Delete a specific alert by ID, or all alerts', {
    alert_id: z.coerce.number().optional().describe('Alert ID to delete (from alert_list)'),
    delete_all: z.coerce.boolean().optional().describe('Delete all alerts'),
  }, async ({ alert_id, delete_all }) => {
    try { return jsonResult(await core.deleteAlerts({ alert_id, delete_all })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
