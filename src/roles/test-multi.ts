#!/usr/bin/env bun
/**
 * Test script for loading multiple roles from a directory
 */

import {
  loadRolesFromDir,
  buildSystemPrompt,
  getRolePermissionsSummary,
} from './index.ts';

console.log('🧪 Testing Multi-Role Loading\n');

// Load all roles from the config directory
import { join } from 'path';
const rolesDir = join(import.meta.dir, '../../roles');
console.log(`Loading roles from ${rolesDir}...`);
const roles = loadRolesFromDir(rolesDir);

console.log(`✅ Loaded ${roles.size} roles:\n`);

// Display summary of each role
for (const [id, role] of roles) {
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`Role: ${role.name} (${id})`);
  console.log(`Description: ${role.description.substring(0, 80)}...`);
  console.log(`Authority Level: ${role.authority_level}/10`);

  const permissions = getRolePermissionsSummary(role);
  console.log(`Capabilities: ${permissions.description}`);

  console.log(`\nStats:`);
  console.log(`  - Responsibilities: ${role.responsibilities.length}`);
  console.log(`  - Autonomous Actions: ${role.autonomous_actions?.length ?? 0}`);
  console.log(`  - Approval Required: ${role.approval_required?.length ?? 0}`);
  console.log(`  - Tools: ${role.tools.length}`);
  console.log(`  - KPIs: ${role.kpis?.length ?? 0}`);
  console.log(`  - Sub-roles: ${role.sub_roles?.length ?? 0}`);
  console.log(`  - Allowed Actions: ${permissions.allowed.length}`);
  console.log(`  - Denied Actions: ${permissions.denied.length}`);

  if (role.communication_style) {
    console.log(`\nCommunication Style:`);
    console.log(`  - Tone: ${role.communication_style.tone}`);
    console.log(`  - Verbosity: ${role.communication_style.verbosity}`);
    console.log(`  - Formality: ${role.communication_style.formality}`);
  }

  if (role.sub_roles && role.sub_roles.length > 0) {
    console.log(`\nCan spawn:`);
    role.sub_roles.forEach(sub => {
      console.log(`  - ${sub.name} (budget: ${sub.max_budget_per_task})`);
    });
  }

  console.log('');
}

// Generate and display a sample prompt for one role
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('Sample System Prompt Generation');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

const executiveRole = roles.get('executive_assistant');
if (executiveRole) {
  const prompt = buildSystemPrompt(executiveRole, {
    userName: 'Alice Johnson',
    currentTime: new Date().toLocaleString(),
    activeCommitments: [
      'Board meeting presentation - Due tomorrow 9 AM',
      'Review Q1 financial reports',
    ],
    recentObservations: [
      'User prefers meetings before noon',
      'User checks Slack frequently but email once per day',
      'User is working on strategic planning this week',
    ],
    agentHierarchy: 'System Admin > Executive Assistant (you) > [Research Specialist, Email Specialist]',
  });

  console.log('Full System Prompt for Executive Assistant:');
  console.log('─'.repeat(80));
  console.log(prompt);
  console.log('─'.repeat(80));
}

// Compare authority levels
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('Authority Level Comparison');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

const sortedRoles = Array.from(roles.values()).sort((a, b) => b.authority_level - a.authority_level);

console.log('Role                     | Authority | Capabilities');
console.log('─────────────────────────|───────────|─────────────────────────────────');

for (const role of sortedRoles) {
  const permissions = getRolePermissionsSummary(role);
  const name = role.name.padEnd(24);
  const level = `${role.authority_level}/10`.padEnd(9);
  console.log(`${name} | ${level} | ${permissions.allowed.length} allowed, ${permissions.denied.length} denied`);
}

console.log('\n✅ Multi-role test complete!');
