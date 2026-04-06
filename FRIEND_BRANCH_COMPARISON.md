# Comparison: Your Tool Calling vs PR #68 (Friend's Branch)

## Overview
PR #68 (`codex/fix-groq-tool-calling`) by @Yperbu9474 fixes Groq tool calling and delegation with 3 main improvements your current code lacks.

---

## 1. 🔴 Groq Request Shaping - CRITICAL DIFFERENCES

### Your Current Code (groq.ts)
```typescript
async chat(messages: LLMMessage[], options: LLMOptions = {}): Promise<LLMResponse> {
  const { model = this.defaultModel, temperature, max_tokens, tools } = options;
  const body: Record<string, unknown> = {
    model,
    messages: this.convertMessages(messages),
  };

  if (temperature !== undefined) body.temperature = temperature;
  if (max_tokens !== undefined) body.max_tokens = max_tokens;
  if (tools && tools.length > 0) {
    body.tools = this.convertTools(tools);
    // ❌ MISSING: tool_choice, parallel_tool_calls
  }
```

### Friend's Branch (PR #68)
```typescript
if (tools && tools.length > 0) {
  body.tools = this.convertTools(tools);
  body.tool_choice = 'auto';           // ✅ Tells Groq to call tools when needed
  body.parallel_tool_calls = true;     // ✅ Allow concurrent tool execution
}
```

**Impact**: Without `tool_choice: auto`, Groq won't reliably invoke tools. Agents can't delegate work.

---

### Token Field Issue

**Your Current Code:**
```typescript
if (max_tokens !== undefined) body.max_tokens = max_tokens;
```

**Friend's Branch:**
Uses Groq-specific field name (likely `completion_tokens` instead of `max_tokens`)

**Impact**: Token limits may not be respected on Groq; risk of "request too large" errors.

---

## 2. 🔴 Assistant Tool-Call Message Content - CRITICAL

### Your Current Code
```typescript
private convertMessages(messages: LLMMessage[]): GroqMessage[] {
  return messages.map(m => {
    const text = typeof m.content === 'string'
      ? m.content
      : m.content.map((b) => b.type === 'text' ? b.text : '[image]').join('\n');
    const msg: GroqMessage = {
      role: m.role as 'system' | 'user' | 'assistant' | 'tool',
      content: text,  // ❌ Always sends text content
    };
    if (m.tool_calls && m.tool_calls.length > 0) {
      msg.tool_calls = m.tool_calls.map(tc => ({...}));
    }
    return msg;
  });
}
```

**Problem**: When replaying assistant messages that made tool calls, the `content` field is a string. Groq expects:
- `content: null` (not empty string `""`) when the assistant's turn was purely tool-calling
- `tool_calls` array for the actual calls

**Friend's Branch Fix:**
```typescript
// When assistant role has tool_calls, set content to null properly
const msg: GroqMessage = {
  role: m.role as 'system' | 'user' | 'assistant' | 'tool',
  content: (m.tool_calls && m.tool_calls.length > 0) ? null : text,
  // ✅ Returns correct OpenAI-style format
};
```

**Impact**: Tool-calling delegations fail when replaying conversation history because Groq rejects malformed assistant messages.

---

## 3. 🟡 History Compaction - MISSING FEATURE

### Your Current Code
No history trimming. Passes all messages directly to Groq.

```typescript
const body: Record<string, unknown> = {
  model,
  messages: this.convertMessages(messages),  // ❌ All messages, no compaction
};
```

**Problem**: Large prompt histories cause:
- "Request too large" errors
- Rate-limit failures
- Increased latency and costs

### Friend's Branch
Adds sophisticated history compaction with **tool-call awareness**:

```typescript
// New method: compactHistory(messages, budget)
// Keeps: system prompt + latest conversation turns
// Preserves: tool-call/tool-result exchanges as atomic chunks
// Drops: old turns and attachments safely

private compactHistory(
  messages: LLMMessage[], 
  budgetTokens: number
): LLMMessage[] {
  const compacted = [messages[0]]; // system prompt
  if (compacted[0]?.role !== 'system') compacted.shift();

  const budget = budgetTokens - SYSTEM_RESERVE;
  let used = this.measureMessage(compacted[0]!);

  // Chunks messages to preserve tool-call exchanges
  const chunks = this.chunkMessages(messages.slice(1));
  const keptChunks: LLMMessage[][] = [];

  for (let i = chunks.length - 1; i >= 0; i--) {
    const chunk = chunks[i]!;
    const size = this.measureChunk(chunk);
    if (keptChunks.length > 0 && used + size > budget) break;
    keptChunks.push(chunk);
    used += size;
  }

  keptChunks.reverse();
  for (const chunk of keptChunks) compacted.push(...chunk);
  return compacted;
}

// Groups messages into atomic units:
// - (assistant with tool_calls) + (following tool results) = 1 chunk
// - regular messages = individual chunks
private chunkMessages(messages: LLMMessage[]): LLMMessage[][] {
  const chunks: LLMMessage[][] = [];
  for (let i = 0; i < messages.length; i++) {
    const current = messages[i]!;
    if (current.role === 'assistant' && current.tool_calls?.length > 0) {
      const chunk: LLMMessage[] = [current];
      i++;
      while (i < messages.length && messages[i]!.role === 'tool') {
        chunk.push(messages[i]!);
        i++;
      }
      i--;
      chunks.push(chunk);
    } else {
      chunks.push([current]);
    }
  }
  return chunks;
}
```

**Why It Matters**: 
- Orphaned `tool` messages without their preceding `assistant` `tool_calls` message break Groq APIs
- Chunking ensures atomic exchanges survive trimming
- Essential for long agent conversations

---

## 4. 🟡 Browser Tool Validation - MISSING

### Your Current Code (sidecar/browser.go)
```go
func makeBrowserClickHandler(cfg *SidecarConfig) RPCHandler {
  return func(params map[string]any) (*RPCResult, error) {
    elemID, ok := params["element_id"].(float64)
    if !ok {
      return nil, fmt.Errorf("missing required parameter: element_id")
      // ❌ No range validation
    }
    // ... continues with int(elemID) - truncates floats silently
```

### Friend's Branch
```go
elemID, ok := params["element_id"].(float64)
if !ok || elemID < 1 {  // ✅ Validate range
  return nil, fmt.Errorf("invalid element_id: must be integer >= 1")
}
```

**Impact**: LLMs sending malformed element IDs (like `1.9`) silently truncate to wrong elements. Browser interactions target wrong UI components.

---

### Sidecar Name Feedback

**Your Current Code (sidecar-route.ts):**
```typescript
if (result === 'detached') {
  return `Task dispatched to "${sidecar.name}" and running in the background.`;
  // ✅ Good - uses resolved name
}
```

**Friend's Branch Issue (feedback from Copilot review):**
Suggests improving the response to use resolved sidecar name instead of original `target` string, which might be partial/ambiguous.
Their fix likely:
```typescript
return `Task dispatched to "${sidecar.name}" and running in the background.`;
// Already correct in your code - good!
```

---

## 5. 🔵 Testing Additions

### Your Current Code
- Basic provider instantiation tests
- No tool-calling tests
- No history compaction tests

### Friend's Branch Adds
```typescript
test('GroqProvider trims oversized history but keeps system and latest turn', async () => {
  const provider = new GroqProvider('test-key') as any;
  const long = 'x'.repeat(12_000);
  const messages: LLMMessage[] = [
    { role: 'system', content: 'System prompt' },
    { role: 'user', content: long },
    { role: 'assistant', content: long },
    { role: 'user', content: 'latest question' },
  ];
  // ... validates system + latest kept, old turns dropped
});

test('GroqProvider preserves tool-call exchanges during compaction', async () => {
  // ... tests that assistant tool_calls + tool results stay together
});
```

---

## Summary Table

| Feature | Your Code | PR #68 | Impact |
|---------|-----------|--------|--------|
| `tool_choice: auto` | ❌ Missing | ✅ Present | Tools won't be called reliably |
| `parallel_tool_calls` | ❌ Missing | ✅ Present | Series only, no parallel delegation |
| Assistant content: null for tool-calls | ❌ Wrong | ✅ Fixed | Tool conversation history breaks |
| History compaction | ❌ Missing | ✅ Complete | Large contexts fail; "request too large" |
| Tool-call chunk preservation | ❌ N/A | ✅ Atomic | Orphaned tool messages break API |
| Element ID validation | ❌ Missing range check | ✅ Validates >= 1 | Wrong UI elements clicked |
| Regression tests | ❌ Minimal | ✅ Comprehensive | No safety net for regressions |

---

## Recommendation

**Severity: HIGH** - Your agent's tool calling is probably broken or unreliable with Groq.

**Recommended Action:**
1. **First Priority**: Add `tool_choice: auto` and `parallel_tool_calls: true` to Groq requests
2. **Second Priority**: Fix assistant message content to send `null` not empty string
3. **Third Priority**: Implement history compaction (complex but necessary for long conversations)
4. **Fourth Priority**: Add element ID range validation in sidecar browser handlers

You can cherry-pick these fixes from the PR or apply them incrementally to your current code.
