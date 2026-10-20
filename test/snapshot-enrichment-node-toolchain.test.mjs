#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const workflowPath = path.resolve(
  process.env.SNAPSHOT_ENRICHMENT_WORKFLOW_PATH || path.resolve(here, '../.github/workflows/enrich-snapshot-pilot.yml'),
);

test('candidate enrichment workflow preserves Node toolchain and pilot contracts', () => {
  const workflow = readFileSync(workflowPath, 'utf8');

  for (const marker of [
    '/Users/be/.local/bin',
    '/Users/be/.local/codex-toolchains/node/bin',
    '/Users/be/.local/codex-toolchains/python312/bin',
    'GITHUB_PATH',
    'command -v node',
    'node --version',
    'MAC_NODE_TOOLCHAIN_MISSING',
  ]) {
    assert.ok(workflow.includes(marker), `missing Mac toolchain marker: ${marker}`);
  }

  const checkout = workflow.indexOf('- name: Checkout the exact dispatch source commit');
  const toolchain = workflow.indexOf('- name: Configure and verify Mac Node toolchain');
  const pilot = workflow.indexOf('- name: Verify source and branch CAS, then run sequential pilot');
  assert.ok(checkout >= 0, 'checkout step missing');
  assert.ok(toolchain > checkout, 'toolchain step must follow checkout');
  assert.ok(pilot > toolchain, 'toolchain step must precede provider pilot');

  const sparseStart = workflow.indexOf('          sparse-checkout: |');
  const sparseEnd = workflow.indexOf('          persist-credentials:', sparseStart);
  assert.ok(sparseStart >= 0 && sparseEnd > sparseStart, 'sparse block missing');
  const sparseEntries = workflow
    .slice(sparseStart, sparseEnd)
    .split(/\r?\n/)
    .filter((line) => /^            \S/.test(line));
  assert.equal(sparseEntries.length, 40, 'sparse-checkout path count drifted');

  for (const marker of [
    'scripts/migration/snapshot-enrichment-provider-binding.json',
    'bash "$pilot"',
    '--binding-manifest "$binding"',
    'SOURCE_COMMIT',
    'DISPATCH_SHA',
    'BRANCH_REF',
    'actual_head=',
    'github.sha',
    'checkout HEAD CAS mismatch',
  ]) {
    assert.ok(workflow.includes(marker), `missing provider/CAS marker: ${marker}`);
  }

  assert.match(
    workflow,
    /NOT_FOR_RELEASE|Deliberately no product data write/,
    'missing NOT_FOR_RELEASE guard marker',
  );
});
