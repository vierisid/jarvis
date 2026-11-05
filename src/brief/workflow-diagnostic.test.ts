import { test, expect } from 'bun:test';
import { workflowDiagnostic } from './workflow-diagnostic';
test('only a bounded static expression diagnosis reaches the inspection UI', () => {
  expect(workflowDiagnostic(null)).toBeNull();
  expect(workflowDiagnostic('Provider error: secret')).toBeNull();
  expect(workflowDiagnostic('WorkflowExpressionError: Unsupported workflow expression: prototype access in {{ secret }}')).toContain('protected object property');
  const message = workflowDiagnostic('WorkflowExpressionError: Unsupported workflow expression: forbidden-function-secret in {{ token }}');
  expect(message).toContain('supported workflow step'); expect(message).not.toContain('secret'); expect(message).not.toContain('token');
});
