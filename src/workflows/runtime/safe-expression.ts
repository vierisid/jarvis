/**
 * Workflow expressions are data, not JavaScript. This interpreter supports own-data
 * references, literals, arrays/objects, primitive operators and flattenNestedKeys.
 * It never evaluates source as code, resolves a global or invokes a supplied function.
 */
export class WorkflowExpressionError extends Error {
  override readonly name = 'WorkflowExpressionError';
}

const fail = (message: string): never => { throw new WorkflowExpressionError(`Unsupported workflow expression: ${message}`); };
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const checkKey = (key: string): string => forbidden.has(key) ? fail('prototype access') : key;
type Token = { kind: 'literal'; value: string | number } | { kind: 'identifier' | 'symbol'; value: string };
type Node =
  | { kind: 'literal'; value: unknown }
  | { kind: 'reference'; name: string }
  | { kind: 'array'; items: Node[] }
  | { kind: 'object'; entries: [string, Node][] }
  | { kind: 'member'; object: Node; key: Node }
  | { kind: 'unary'; operator: string; value: Node }
  | { kind: 'binary'; operator: string; left: Node; right: Node }
  | { kind: 'conditional'; condition: Node; yes: Node; no: Node }
  | { kind: 'flatten'; data: Node; path: Node };
const precedence: Record<string, number> = Object.assign(Object.create(null), {
  '??': 1, '||': 2, '&&': 3, '===': 4, '!==': 4, '==': 4, '!=': 4,
  '<': 5, '<=': 5, '>': 5, '>=': 5, '+': 6, '-': 6, '*': 7, '/': 7, '%': 7,
});

function tokenize(script: string): Token[] {
  if (script.length > 16_384) fail('source length limit');
  const tokens: Token[] = [];
  let i = 0;
  while (i < script.length) {
    const c = script[i]!;
    if (/\s/u.test(c)) { i++; continue; }
    if (tokens.length >= 2048) fail('token limit');
    if (c === '"' || c === "'") {
      i++;
      let value = '', closed = false;
      while (i < script.length) {
        const next = script[i++]!;
        if (next === c) { closed = true; break; }
        if (next !== '\\') { value += next; continue; }
        const escaped = script[i++];
        const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '\\': '\\', "'": "'", '"': '"', '/': '/' };
        if (escaped === 'u') {
          const hex = script.slice(i, i + 4);
          if (!/^[\da-f]{4}$/i.test(hex)) fail('invalid Unicode escape');
          value += String.fromCharCode(parseInt(hex, 16)); i += 4;
        } else if (escaped && Object.hasOwn(escapes, escaped)) value += escapes[escaped];
        else fail('invalid string escape');
      }
      if (!closed) fail('unterminated string');
      tokens.push({ kind: 'literal', value });
    } else {
      const rest = script.slice(i);
      const number = rest.match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
      const identifier = rest.match(/^[$_\p{L}][$_\p{L}\p{N}]*/u);
      const symbol = rest.match(/^(?:===|!==|==|!=|<=|>=|&&|\|\||\?\?|\?\.|[.\[\](){},?:+*/%!<>-])/);
      if (number) { tokens.push({ kind: 'literal', value: Number(number[0]) }); i += number[0].length; }
      else if (identifier) { tokens.push({ kind: 'identifier', value: identifier[0] }); i += identifier[0].length; }
      else if (symbol) { tokens.push({ kind: 'symbol', value: symbol[0] }); i += symbol[0].length; }
      else fail('unsupported syntax');
    }
  }
  return tokens;
}

class Parser {
  private index = 0;
  private depth = 0;
  constructor(private tokens: Token[]) {}
  private is(value: string): boolean { const t = this.tokens[this.index]; return t?.kind === 'symbol' && t.value === value; }
  private take(value: string): boolean { if (!this.is(value)) return false; this.index++; return true; }
  private require(value: string): void { if (!this.take(value)) fail(`expected ${value}`); }

  parse(): Node {
    const node = this.expression();
    if (this.index !== this.tokens.length) fail('function calls or other executable syntax');
    return node;
  }

  private expression(minimum = 0): Node {
    if (++this.depth > 64) fail('nesting limit');
    let left = this.primary();
    while (true) {
      const token = this.tokens[this.index];
      const operator = token?.kind === 'symbol' ? token.value : '';
      const rank = precedence[operator];
      if (rank === undefined || rank < minimum) break;
      this.index++;
      left = { kind: 'binary', operator, left, right: this.expression(rank + 1) };
    }
    if (minimum === 0 && this.take('?')) {
      const yes = this.expression(); this.require(':');
      left = { kind: 'conditional', condition: left, yes, no: this.expression() };
    }
    this.depth--;
    return left;
  }

  private primary(): Node {
    const token = this.tokens[this.index++];
    if (!token) return fail('missing value');
    let node: Node;
    if (token.kind === 'literal') node = { kind: 'literal', value: token.value };
    else if (token.kind === 'identifier') {
      const name = checkKey(token.value);
      if (name === 'true' || name === 'false' || name === 'null' || name === 'undefined') {
        node = { kind: 'literal', value: name === 'true' ? true : name === 'false' ? false : name === 'null' ? null : undefined };
      } else if (name === 'flattenNestedKeys' && this.take('(')) {
        const data = this.expression(); this.require(',');
        const path = this.expression(); this.require(')');
        node = { kind: 'flatten', data, path };
      } else node = { kind: 'reference', name };
    } else if (['!', '-', '+'].includes(token.value)) {
      node = { kind: 'unary', operator: token.value, value: this.expression(8) };
    } else if (token.value === '(') { node = this.expression(); this.require(')'); }
    else if (token.value === '[') {
      const items: Node[] = [];
      while (!this.take(']')) {
        items.push(this.expression());
        if (this.take(']')) break;
        this.require(',');
      }
      node = { kind: 'array', items };
    } else if (token.value === '{') {
      const entries: [string, Node][] = [];
      while (!this.take('}')) {
        const key = this.tokens[this.index++];
        if (!key || key.kind === 'symbol') fail('object key must be a literal');
        this.require(':');
        entries.push([checkKey(String(key!.value)), this.expression()]);
        if (this.take('}')) break;
        this.require(',');
      }
      node = { kind: 'object', entries };
    } else return fail('unsupported value');
    while (true) {
      if (this.take('[')) {
        const key = this.expression(); this.require(']'); node = { kind: 'member', object: node, key };
      } else if (this.take('.') || this.take('?.')) {
        if (this.take('[')) {
          const key = this.expression(); this.require(']'); node = { kind: 'member', object: node, key };
        } else {
          const key = this.tokens[this.index++];
          if (!key || key.kind !== 'identifier') fail('expected property name');
          node = { kind: 'member', object: node, key: { kind: 'literal', value: checkKey(String(key!.value)) } };
        }
      } else break;
    }
    return node;
  }
}

/** Shared budget bounds evaluation, flatten traversal and materialized output. */
class Budget {
  private visits = 0;
  private characters = 0;
  visit(depth: number): void { if (++this.visits > 10_000 || depth > 64) fail('value or nesting limit'); }
  string(value: string): string {
    this.characters += value.length;
    if (this.characters > 1_048_576) fail('output size limit');
    return value;
  }
}

function ownData(object: unknown, key: unknown): unknown {
  if (typeof key !== 'string' && (typeof key !== 'number' || !Number.isFinite(key))) fail('invalid property key');
  const name = checkKey(String(key));
  if (object === null || object === undefined) return undefined;
  if (typeof object === 'function' || typeof object === 'symbol') fail('non-data value');
  const descriptor = Object.getOwnPropertyDescriptor(object, name);
  if (!descriptor) return undefined;
  if (!('value' in descriptor)) fail('accessor property');
  return descriptor.value;
}

function primitive(value: unknown): string | number | boolean | null | undefined {
  if (typeof value === 'string' && value.length > 1_048_576) fail('value size limit');
  if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return fail('operators require finite primitive values');
}

function copyData(value: unknown, budget: Budget, depth = 0): unknown {
  budget.visit(depth);
  if (typeof value === 'string') return budget.string(value);
  if (value === null || typeof value !== 'object') return primitive(value);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype && prototype !== Array.prototype) fail('non-JSON object');
  if (Array.isArray(value)) {
    if (value.length > 10_000) fail('array size limit');
    return Array.from({ length: value.length }, (_, i) => copyData(ownData(value, i), budget, depth + 1));
  }
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    budget.string(key);
    result[checkKey(key)] = copyData(ownData(value, key), budget, depth + 1);
  }
  return result;
}

function binary(operator: string, leftValue: unknown, rightValue: unknown): unknown {
  const left = primitive(leftValue), right = primitive(rightValue);
  switch (operator) {
    case '===': return left === right;
    case '!==': return left !== right;
    // Both operands are primitives, so coercion cannot invoke user code.
    case '==': return left == right;
    case '!=': return left != right;
    case '<': return typeof left === 'string' && typeof right === 'string' ? left < right : Number(left) < Number(right);
    case '<=': return typeof left === 'string' && typeof right === 'string' ? left <= right : Number(left) <= Number(right);
    case '>': return typeof left === 'string' && typeof right === 'string' ? left > right : Number(left) > Number(right);
    case '>=': return typeof left === 'string' && typeof right === 'string' ? left >= right : Number(left) >= Number(right);
    case '+': return typeof left === 'string' || typeof right === 'string' ? String(left) + String(right) : Number(left) + Number(right);
    case '-': return Number(left) - Number(right);
    case '*': return Number(left) * Number(right);
    case '/': return Number(left) / Number(right);
    case '%': return Number(left) % Number(right);
    default: return fail('unknown operator');
  }
}

export function evaluateWorkflowExpression(script: string, context: Record<string, unknown>): unknown {
  const tree = new Parser(tokenize(script)).parse();
  const budget = new Budget();
  const evaluate = (node: Node, depth = 0): unknown => {
    budget.visit(depth);
    const child = (value: Node) => evaluate(value, depth + 1);
    switch (node.kind) {
      case 'literal': return primitive(node.value);
      case 'reference': return ownData(context, node.name);
      case 'array': return node.items.map(child);
      case 'object': return Object.fromEntries(node.entries.map(([key, value]) => [key, child(value)]));
      case 'member': return ownData(child(node.object), child(node.key));
      case 'unary': {
        const value = primitive(child(node.value));
        return node.operator === '!' ? !value : primitive(node.operator === '-' ? -Number(value) : Number(value));
      }
      case 'binary': {
        const left = child(node.left);
        if (node.operator === '&&') return left ? child(node.right) : left;
        if (node.operator === '||') return left ? left : child(node.right);
        if (node.operator === '??') return left === null || left === undefined ? child(node.right) : left;
        const result = primitive(binary(node.operator, left, child(node.right)));
        return typeof result === 'string' ? budget.string(result) : result;
      }
      case 'conditional': return child(node.condition) ? child(node.yes) : child(node.no);
      case 'flatten': {
        const data = copyData(child(node.data), budget), path = copyData(child(node.path), budget);
        if (!Array.isArray(path) || path.some(key => typeof key !== 'string')) return fail('flatten path must be a string array');
        path.forEach(checkKey);
        const values: unknown[] = [];
        const walk = (value: unknown, position: number, level: number): void => {
          budget.visit(level);
          if (Array.isArray(value)) value.forEach(item => walk(item, position, level + 1));
          else if (value !== null && typeof value === 'object') {
            if (position < path.length && Object.hasOwn(value, path[position])) walk(ownData(value, path[position]), position + 1, level + 1);
          } else if (position === path.length) values.push(value);
        };
        walk(data, 0, 0);
        return values;
      }
    }
  };
  return copyData(evaluate(tree), budget);
}
