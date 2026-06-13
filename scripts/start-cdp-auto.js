#!/usr/bin/env node
/**
 * Auto-launch TradingView with CDP and run health check
 * Usage: node scripts/start-cdp-auto.js
 */

import { launch } from './launch.js';
import { healthCheck } from './health.js';

async function main() {
  console.log('=== TradingView CDP Auto-Launch ===\n');

  // Step 1: Launch with CDP
  console.log('Step 1: Launching TradingView with CDP...');
  const launchResult = await launch({ port: 9222, kill_existing: true });
  console.log('Launch result:', JSON.stringify(launchResult, null, 2));

  // Step 2: Wait for TradingView to fully start
  console.log('\nStep 2: Waiting 5 seconds for TradingView to initialize...');
  await new Promise(resolve => setTimeout(resolve, 5000));

  // Step 3: Run health check
  console.log('\nStep 3: Running health check...');
  try {
    const health = await healthCheck();
    console.log('\n=== Health Check Result ===');
    console.log(JSON.stringify(health, null, 2));

    if (health.success) {
      console.log('\nTradingView CDP is ready!');
    } else {
      console.log('\nHealth check reported issues. TradingView may still be starting.');
    }
  } catch (err) {
    console.log('\nHealth check failed:', err.message);
    console.log('TradingView may still be starting. Try running tv_health_check again in a few seconds.');
  }
}

main().catch(console.error);