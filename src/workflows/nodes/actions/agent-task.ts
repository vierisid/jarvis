import type { NodeDefinition } from '../registry.ts';

export const agentTaskAction: NodeDefinition = {
  type: 'action.agent_task',
  label: 'Agent Task',
  description: 'Dispatch a task to a sub-agent and await its response.',
  category: 'action',
  icon: '🤖',
  color: '#3b82f6',
  configSchema: {
    task: {
      type: 'template',
      label: 'Task',
      description: 'The task description to send to the sub-agent. Supports template expressions.',
      required: true,
      placeholder: 'Summarize the following: {{data.content}}',
    },
    max_iterations: {
      type: 'number',
      label: 'Max Iterations',
      description: 'Maximum tool-loop iterations the sub-agent may run.',
      required: false,
      default: 100,
    },
  },
  inputs: ['default'],
  outputs: ['default'],
  execute: async (input, config, ctx) => {
    const task = String(config.task ?? '');
    const maxIterations = typeof config.max_iterations === 'number' ? config.max_iterations : 100;

    ctx.logger.info(`Dispatching agent task (max ${maxIterations} iterations): ${task.slice(0, 120)}`);

    const llm = ctx.llmManager as any;
    if (!llm?.chat) {
      throw new Error('LLM manager not available — cannot dispatch agent task');
    }

    // Build context from input data
    const dataContext = JSON.stringify(input.data).slice(0, 2000);
    const messages = [
      {
        role: 'system' as const,
        content: `You are a workflow sub-agent. Complete the following task concisely. You have access to the following context data:\n\n${dataContext}\n\nRespond with the task result only.`,
      },
      {
        role: 'user' as const,
        content: task,
      },
    ];

    const llmResponse = await llm.chat(messages, {
      temperature: 0.3,
      max_tokens: 2000,
    });

    const response = typeof llmResponse.content === 'string'
      ? llmResponse.content
      : JSON.stringify(llmResponse.content);

    ctx.logger.info(`Agent task completed (${response.length} chars)`);

    return {
      data: {
        ...input.data,
        task,
        response,
        success: true,
        max_iterations: maxIterations,
      },
    };
  },
};
