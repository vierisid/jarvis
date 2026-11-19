/**
 * Speaks to the collab engine: the brain's end of the line.
 *
 * The engine (./README in docs/peers) is a separate program that keeps the
 * keys, the pairing, the encryption and the mailbox. It was made to sit under
 * a coding agent and talks MCP over its standard input and output: one JSON
 * message a line. This is the smallest client that does what the brain needs
 * of it: call a tool, hear a notice, and be handed a dialog.
 *
 * The one rule of this file: A DIALOG IS NEVER ANSWERED HERE. Whatever the
 * engine asks of the person (approve a request, send a result, trust a
 * device) is passed to `onDialog` and the answer that comes back is passed
 * on unchanged. With nobody to ask, or when asking fails, the dialog is
 * closed, which the engine treats as "nothing changed". There is no path in
 * this file that says yes.
 */

/** One line each way. The process behind it is ./engine-process.ts; tests pass their own. */
export interface EngineTransport {
  send(line: string): void;
  onLine(listener: (line: string) => void): void;
  /** The other end went away. */
  onClose(listener: () => void): void;
  close(): void;
}

export interface EngineDialogOption { value: string; title: string }

export interface EngineDialogField {
  type: string;
  title?: string;
  description?: string;
  /** The choices of a field that is a choice, in the engine's order. */
  options?: EngineDialogOption[];
  default?: unknown;
  maxLength?: number;
}

/** Something the engine asks of the person. */
export interface EngineDialog {
  /** A form to answer, or a web page to open. */
  mode: 'form' | 'url';
  /** The engine's own words, shown as they are. */
  message: string;
  fields: Record<string, EngineDialogField>;
  required: string[];
  /** Mode url: the page, and the engine's name for this opening of it. */
  url?: string;
  elicitationId?: string;
  /** The tool call that was waiting when it came, if one was: what the dialog belongs to. */
  during: { tool: string; args: Record<string, unknown> } | null;
}

/**
 * The person's answer. `accept` carries what they chose; `decline` is their
 * no; `cancel` is "closed without an answer", which changes nothing.
 */
export type EngineDialogAnswer =
  | { action: 'accept'; content?: Record<string, unknown> }
  | { action: 'decline' }
  | { action: 'cancel' };

export interface EngineToolResult {
  /** The engine's answer. It is prose, written for a reader. */
  text: string;
  /** The engine marked it as a failure. */
  failed: boolean;
}

export interface EngineClientOptions {
  /** Puts a dialog to the person and resolves with their answer. Without it every dialog is closed. */
  onDialog?: (dialog: EngineDialog) => Promise<EngineDialogAnswer>;
  /** A notice from the engine: something arrived, a page was finished with. */
  onNotice?: (method: string, params: Record<string, unknown>) => void;
  /** Folders the engine may be told the brain works in. None by default: the brain is not a project. */
  roots?: string[];
  /** How long the engine has to say hello. */
  helloMs?: number;
  /** How long a tool call may take when the caller names no limit. */
  callMs?: number;
  version?: string;
}

/** The newest protocol the engine speaks. It is the one that knows a dialog can be a web page. */
export const ENGINE_PROTOCOL = '2025-11-25';
export const ENGINE_HELLO_MS = 10_000;
/** Long: a call can wait on a dialog, and the engine gives a person up to half an hour. */
export const ENGINE_CALL_MS = 35 * 60_000;
/** A line longer than this is not the engine's: its own cap for one tool answer is far below. */
export const ENGINE_LINE_MAX = 4 * 1024 * 1024;

export class EngineClosed extends Error {
  constructor(message = 'the engine went away') { super(message); this.name = 'EngineClosed'; }
}

export class EngineRefused extends Error {
  constructor(readonly code: number, message: string) { super(message); this.name = 'EngineRefused'; }
}

interface Waiting {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** What the engine asks for in a form, read without trusting its shape. */
export function readDialogFields(schema: unknown): { fields: Record<string, EngineDialogField>; required: string[] } {
  const fields: Record<string, EngineDialogField> = {};
  for (const [name, raw] of Object.entries(record(record(schema).properties))) {
    const field = record(raw);
    const options: EngineDialogOption[] = [];
    if (Array.isArray(field.oneOf)) {
      for (const one of field.oneOf) {
        const option = record(one);
        if (typeof option.const === 'string') options.push({ value: option.const, title: typeof option.title === 'string' ? option.title : option.const });
      }
    } else if (Array.isArray(field.enum)) {
      const names = Array.isArray(field.enumNames) ? field.enumNames : [];
      field.enum.forEach((value, at) => {
        if (typeof value === 'string') options.push({ value, title: typeof names[at] === 'string' ? names[at] as string : value });
      });
    }
    fields[name] = {
      type: typeof field.type === 'string' ? field.type : 'string',
      ...(typeof field.title === 'string' ? { title: field.title } : {}),
      ...(typeof field.description === 'string' ? { description: field.description } : {}),
      ...(options.length ? { options } : {}),
      ...(field.default !== undefined ? { default: field.default } : {}),
      ...(typeof field.maxLength === 'number' ? { maxLength: field.maxLength } : {}),
    };
  }
  const required = Array.isArray(record(schema).required) ? (record(schema).required as unknown[]).filter((one): one is string => typeof one === 'string') : [];
  return { fields, required };
}

export class EngineClient {
  private next = 1;
  private readonly waiting = new Map<number, Waiting>();
  /** The tool calls that are waiting now, oldest first: a dialog belongs to the oldest. */
  private readonly calling: { id: number; tool: string; args: Record<string, unknown> }[] = [];
  private closed = false;
  private closeListeners: (() => void)[] = [];

  constructor(private readonly transport: EngineTransport, private readonly options: EngineClientOptions = {}) {
    transport.onLine((line) => this.heard(line));
    transport.onClose(() => this.ended());
  }

  /** Says hello. Resolves with what the engine calls itself. */
  async start(): Promise<{ name: string; version: string; protocol: string }> {
    const hello = record(await this.request('initialize', {
      protocolVersion: ENGINE_PROTOCOL,
      // Both kinds of dialog, and nothing else: the brain lends the engine no model and no files.
      capabilities: { elicitation: { form: {}, url: {} }, roots: { listChanged: false } },
      clientInfo: { name: 'jarvis', version: this.options.version ?? '0' },
    }, this.options.helloMs ?? ENGINE_HELLO_MS));
    this.notify('notifications/initialized');
    const info = record(hello.serverInfo);
    return {
      name: typeof info.name === 'string' ? info.name : '',
      version: typeof info.version === 'string' ? info.version : '',
      protocol: typeof hello.protocolVersion === 'string' ? hello.protocolVersion : '',
    };
  }

  /** The names of the engine's tools. */
  async tools(): Promise<string[]> {
    const listed = record(await this.request('tools/list', {}, this.options.helloMs ?? ENGINE_HELLO_MS));
    return (Array.isArray(listed.tools) ? listed.tools : []).map((tool) => record(tool).name).filter((name): name is string => typeof name === 'string');
  }

  /** Calls one tool and waits for its answer, through any dialog it opens on the way. */
  async call(tool: string, args: Record<string, unknown> = {}, limitMs?: number): Promise<EngineToolResult> {
    const id = this.next;
    this.calling.push({ id, tool, args });
    try {
      const result = record(await this.request('tools/call', { name: tool, arguments: args }, limitMs ?? this.options.callMs ?? ENGINE_CALL_MS));
      const text = (Array.isArray(result.content) ? result.content : [])
        .map((part) => record(part)).filter((part) => part.type === 'text' && typeof part.text === 'string').map((part) => part.text as string).join('\n');
      return { text, failed: result.isError === true };
    } finally {
      const at = this.calling.findIndex((one) => one.id === id);
      if (at >= 0) this.calling.splice(at, 1);
    }
  }

  onClosed(listener: () => void): void {
    if (this.closed) listener(); else this.closeListeners.push(listener);
  }

  close(): void {
    this.transport.close();
    this.ended();
  }

  private request(method: string, params: Record<string, unknown>, limitMs: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new EngineClosed());
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new EngineClosed(`the engine did not answer ${method} in time`));
      }, limitMs);
      (timer as { unref?: () => void }).unref?.();
      this.waiting.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  private notify(method: string): void { this.write({ jsonrpc: '2.0', method }); }

  private write(message: Record<string, unknown>): void {
    if (this.closed) return;
    try { this.transport.send(JSON.stringify(message)); } catch { this.ended(); }
  }

  private heard(line: string): void {
    if (this.closed || !line.trim() || line.length > ENGINE_LINE_MAX) return;
    let message: Record<string, unknown>;
    try { message = record(JSON.parse(line)); } catch { return; }
    const id = message.id;
    if (typeof message.method === 'string') {
      if (id === undefined || id === null) this.options.onNotice?.(message.method, record(message.params));
      else void this.asked(id as string | number, message.method, record(message.params));
      return;
    }
    if (typeof id !== 'number') return;
    const waiting = this.waiting.get(id);
    if (!waiting) return;
    this.waiting.delete(id);
    clearTimeout(waiting.timer);
    if (message.error) {
      const error = record(message.error);
      waiting.reject(new EngineRefused(typeof error.code === 'number' ? error.code : 0, typeof error.message === 'string' ? error.message : 'refused'));
    } else waiting.resolve(message.result);
  }

  /** The engine asks something of the brain. */
  private async asked(id: string | number, method: string, params: Record<string, unknown>): Promise<void> {
    if (method === 'elicitation/create') {
      const answer = await this.put(params);
      this.write({ jsonrpc: '2.0', id, result: answer });
      return;
    }
    if (method === 'roots/list') {
      this.write({ jsonrpc: '2.0', id, result: { roots: (this.options.roots ?? []).map((folder) => ({ uri: `file://${folder}`, name: folder })) } });
      return;
    }
    if (method === 'ping') { this.write({ jsonrpc: '2.0', id, result: {} }); return; }
    // Anything else (lending it a model, most of all) the brain does not do.
    this.write({ jsonrpc: '2.0', id, error: { code: -32601, message: 'not supported' } });
  }

  /** Puts a dialog to whoever answers for the person. Closed when nobody does. */
  private async put(params: Record<string, unknown>): Promise<EngineDialogAnswer> {
    const closed: EngineDialogAnswer = { action: 'cancel' };
    if (!this.options.onDialog) return closed;
    const { fields, required } = readDialogFields(params.requestedSchema);
    const belongs = this.calling[0];
    const dialog: EngineDialog = {
      mode: params.mode === 'url' ? 'url' : 'form',
      message: typeof params.message === 'string' ? params.message : '',
      fields,
      required,
      ...(typeof params.url === 'string' ? { url: params.url } : {}),
      ...(typeof params.elicitationId === 'string' ? { elicitationId: params.elicitationId } : {}),
      during: belongs ? { tool: belongs.tool, args: belongs.args } : null,
    };
    try {
      const answer = await this.options.onDialog(dialog);
      if (answer.action === 'accept') return { action: 'accept', ...(answer.content ? { content: answer.content } : {}) };
      return answer.action === 'decline' ? { action: 'decline' } : closed;
    } catch {
      return closed;
    }
  }

  private ended(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, waiting] of this.waiting) {
      clearTimeout(waiting.timer);
      waiting.reject(new EngineClosed());
    }
    this.waiting.clear();
    this.calling.length = 0;
    const listeners = this.closeListeners;
    this.closeListeners = [];
    for (const listener of listeners) { try { listener(); } catch { /* a listener's own fault */ } }
  }
}
