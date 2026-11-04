export async function request(context: any) {
  const response = await fetch(context.server.apiUrl.replace(/\/$/, '') + '/v1/jarvis/human-input', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + context.server.token,
      'X-Jarvis-Step-Name': context.step.name, 'X-Jarvis-Execution-Path': JSON.stringify(context.step.executionPath ?? []) }, body: JSON.stringify(context.propsValue),
  });
  if (!response.ok) throw Error((await response.text()).slice(0, 1000));
  const result = await response.json() as any;
  if (response.status === 202) context.run.waitForWaitpoint(result.waitpointId);
  return result;
}
