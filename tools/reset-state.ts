#!/usr/bin/env ts-node
/**
 * Reset bot state. Run via npm scripts:
 *
 *   npm run reset:all          — clear all state (both pollers)
 *   npm run reset:audit        — clear audit/bamboo state only
 *   npm run reset:pr           — clear PR poller state only
 *   npm run reset:pr -- 707    — clear state for a specific PR (across all repos)
 */

import * as fs from 'fs';
import * as path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const BAMBOO_STATE_FILE = path.join(DATA_DIR, 'bamboo-state.json');

const args = process.argv.slice(2);
const command = args[0] ?? 'help';
const prId = args[1];

function loadJson(file: string): any {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function saveJson(file: string, data: any): void {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

switch (command) {
  case 'all': {
    if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
    if (fs.existsSync(BAMBOO_STATE_FILE)) fs.unlinkSync(BAMBOO_STATE_FILE);
    console.log('Deleted state.json and bamboo-state.json. Next cycle starts fresh.');
    break;
  }

  case 'audit': {
    const data = loadJson(BAMBOO_STATE_FILE);
    if (!data) {
      console.log('No bamboo-state.json found.');
      break;
    }
    const buildCount = Object.keys(data.builds ?? {}).length;
    const auditPrCount = Object.keys(data.auditPrs ?? {}).length;
    data.builds = {};
    delete data.auditPrs;
    saveJson(BAMBOO_STATE_FILE, data);
    console.log(`Cleared ${buildCount} build(s) and ${auditPrCount} audit PR tracker(s).`);
    console.log('Next audit cycle will re-check all builds and create new audit PRs if needed.');
    break;
  }

  case 'pr': {
    const data = loadJson(STATE_FILE);
    if (!data) {
      console.log('No state.json found.');
      break;
    }

    if (prId) {
      // Clear state for a specific PR
      let found = false;
      for (const [repoKey, repoState] of Object.entries(data.repos ?? {})) {
        const rs = repoState as { pullRequests: Record<string, unknown> };
        if (rs?.pullRequests?.[prId]) {
          delete rs.pullRequests[prId];
          found = true;
          console.log(`Cleared PR #${prId} from ${repoKey}`);
        }
      }
      if (!found) {
        console.log(`PR #${prId} not found in state.`);
      } else {
        saveJson(STATE_FILE, data);
        console.log(`PR #${prId} will be re-reviewed and mentions re-scanned on next cycle.`);
      }
    } else {
      // Clear all PR state
      const repoCount = Object.keys(data.repos ?? {}).length;
      data.repos = {};
      saveJson(STATE_FILE, data);
      console.log(`Cleared state for ${repoCount} repo(s). All PRs will be re-reviewed on next cycle.`);
    }
    break;
  }

  default:
    console.log(`Usage:
  npm run reset:all          Clear all state (both pollers start fresh)
  npm run reset:audit        Clear audit state (re-check builds, re-create audit PRs)
  npm run reset:pr           Clear all PR state (re-review all PRs)
  npm run reset:pr -- 707    Clear state for PR #707 only`);
    break;
}
