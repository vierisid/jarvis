import { describe, expect, test } from 'bun:test';
import { calledWorkflowFailure, plainStepMessage, serverRefusalStatus } from './step-error';

describe('plainStepMessage', () => {
  test('a governed refusal reads as the sentence inside the daemon reply', () => {
    const raw = 'Governed piece @activepieces/piece-http/send_request was not authorized: daemon responded 409: '
      + '{"error":"Jarvis does not send requests to addresses on this computer or local network.","outcome":{"status":"blocked","code":"X"}}';
    expect(plainStepMessage(raw)).toBe('Jarvis does not send requests to addresses on this computer or local network.');
  });

  test('a reply cut at 500 characters still gives its sentence', () => {
    const raw = 'Governed piece p/a was not authorized: daemon responded 409: {"error":"Sending a request to another server needs your approval.","detail":"' + 'x'.repeat(400);
    expect(plainStepMessage(raw)).toBe('Sending a request to another server needs your approval.');
  });

  test('a printed action outcome reads as its message', () => {
    expect(plainStepMessage('blocked HUMAN_INPUT_REJECTED: Human request rejected')).toBe('Human request rejected');
  });

  test('text with no wrapper is unchanged', () => {
    expect(plainStepMessage('The server answered 404 Not Found.')).toBe('The server answered 404 Not Found.');
    expect(plainStepMessage('daemon responded fine')).toBe('daemon responded fine');
  });
});

describe('what a step error settles', () => {
  test('only a 4xx answer from the server settles a request', () => {
    expect(serverRefusalStatus('The server answered 404 Not Found.')).toBe(404);
    expect(serverRefusalStatus('{"response":{"status":403,"body":""},"request":{}}')).toBe(403);
    expect(serverRefusalStatus('The server answered 503 Service Unavailable.')).toBeNull();
    expect(serverRefusalStatus('The request timed out after 30 seconds.')).toBeNull();
    expect(serverRefusalStatus('Could not reach example.com.')).toBeNull();
  });

  test('only a child that failed settles a call', () => {
    expect(calledWorkflowFailure('The workflow "Ledger" failed. Open its latest run to see why. This step failed with it.')).toEqual({ child: 'Ledger' });
    expect(calledWorkflowFailure('Reusable child did not succeed: failed (CHILD_FAILED)')).toEqual({});
    expect(calledWorkflowFailure('The workflow "Ledger" did not finish within 30 seconds.')).toBeNull();
    expect(calledWorkflowFailure('The workflow "Ledger" stopped before it could report back, so it is not known whether it finished.')).toBeNull();
  });
});
