#!/usr/bin/env bun
/**
 * Test script for the Role Engine
 */

import {
  loadRole,
  validateRole,
  buildSystemPrompt,
  canPerform,
  listAllowedActions,
  listDeniedActions,
  getRolePermissionsSummary,
  type RoleDefinition,
  type ActionCategory,
} from './index.ts';

console.log('🧪 Testing Role Engine\n');

// Test 1: Load a role from YAML
console.log('Test 1: Loading role from YAML...');
try {
  const role = loadRole(import.meta.dir + '/test-role.yaml');
  console.log(`✅ Loaded role: ${role.name} (${role.id})`);
  console.log(`   Authority Level: ${role.authority_level}`);
  console.log(`   Responsibilities: ${role.responsibilities.length}`);
  console.log(`   Tools: ${role.tools.length}`);
  console.log(`   KPIs: ${role.kpis?.length ?? 0}`);
  console.log(`   Sub-roles: ${role.sub_roles?.length ?? 0}`);
} catch (error) {
  console.error('❌ Failed to load role:', error);
  process.exit(1);
}

// Test 2: Validate role
console.log('\nTest 2: Validating role...');
const role = loadRole(import.meta.dir + '/test-role.yaml');
const isValid = validateRole(role);
console.log(isValid ? '✅ Role is valid' : '❌ Role is invalid');

// Test 3: Build system prompt
console.log('\nTest 3: Building system prompt...');
const prompt = buildSystemPrompt(role, {
  userName: 'John Doe',
  currentTime: new Date().toLocaleString(),
  activeCommitments: [
    'Finish Q1 report by Friday',
    'Prepare presentation for Monday meeting',
  ],
  recentObservations: [
    'User prefers morning meetings',
    'User checks email every 2 hours',
  ],
  agentHierarchy: 'Executive Assistant (you) > Research Specialist, Email Specialist',
});
console.log('✅ System prompt generated');
console.log(`   Length: ${prompt.length} characters`);
console.log('\n--- PROMPT PREVIEW ---');
console.log(prompt.substring(0, 500) + '...\n');

// Test 4: Authority checks
console.log('Test 4: Testing authority system...');
const permissions = getRolePermissionsSummary(role);
console.log(`✅ Authority Level: ${permissions.level}/10`);
console.log(`   ${permissions.description}`);
console.log(`   Allowed actions: ${permissions.allowed.length}`);
console.log(`   Denied actions: ${permissions.denied.length}`);

// Test specific actions
const actionsToTest: ActionCategory[] = [
  'read_data',
  'write_data',
  'execute_command',
  'spawn_agent',
  'make_payment',
];

console.log('\nAction Permissions:');
for (const action of actionsToTest) {
  const can = canPerform(role, action);
  console.log(`   ${can ? '✅' : '❌'} ${action}`);
}

// Test 5: List allowed/denied actions
console.log('\nTest 5: Listing all permissions...');
const allowed = listAllowedActions(role);
const denied = listDeniedActions(role);

console.log('\n✅ Allowed Actions:');
allowed.forEach(action => console.log(`   - ${action}`));

console.log('\n❌ Denied Actions:');
denied.forEach(action => console.log(`   - ${action}`));

// Test 6: Invalid role validation
console.log('\nTest 6: Testing validation with invalid data...');
const invalidRole = {
  id: 'test',
  name: 'Test',
  // Missing required fields
};

const isInvalid = validateRole(invalidRole);
console.log(isInvalid ? '❌ Should have been invalid!' : '✅ Correctly rejected invalid role');

console.log('\n✅ All tests passed!');
