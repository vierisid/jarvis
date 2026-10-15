# J.A.R.V.I.S. Communication Layer

The communication layer provides multi-channel messaging, WebSocket-based real-time communication, LLM response streaming, and voice I/O capabilities.

## Architecture

```
comms/
├── websocket.ts       # Local WebSocket server using Bun.serve()
├── streaming.ts       # LLM stream relay to WebSocket clients
├── voice.ts          # STT/TTS provider interfaces and stubs
├── channels/         # Multi-platform messaging adapters
│   ├── telegram.ts   # ✅ Telegram Bot API (fully functional)
│   ├── whatsapp.ts   # 🚧 WhatsApp Business API (stub)
│   ├── discord.ts    # 🚧 Discord Bot (stub)
│   └── signal.ts     # 🚧 Signal CLI (stub)
└── index.ts          # ChannelManager and exports
```

## Core Components

### 1. WebSocket Server

Real-time bidirectional communication with web clients.

```typescript
import { WebSocketServer } from './comms';

const wsServer = new WebSocketServer(3142);

wsServer.setHandler({
  async onMessage(msg) {
    console.log('Received:', msg.type, msg.payload);
    return { type: 'status', payload: 'Acknowledged', timestamp: Date.now() };
  },
  onConnect() {
    console.log('Client connected');
  },
  onDisconnect() {
    console.log('Client disconnected');
  },
});

wsServer.start();
```

**Endpoints:**
- `ws://localhost:3142/ws` - WebSocket connection
- `http://localhost:3142/health` - Health check
- `http://localhost:3142/` - Server info

**Message Types:**
```typescript
type WSMessage = {
  type: 'chat' | 'command' | 'status' | 'stream' | 'error';
  payload: unknown;
  id?: string;
  timestamp: number;
};
```

### 2. Stream Relay

Relays LLM streaming responses to connected WebSocket clients in real-time.

```typescript
import { StreamRelay, WebSocketServer } from './comms';

const wsServer = new WebSocketServer();
wsServer.start();

const relay = new StreamRelay(wsServer);

// Relay LLM stream to all connected clients
const stream = llmProvider.generateStream(prompt);
const fullResponse = await relay.relayStream(stream, 'request-123');
```

Clients receive incremental updates:
```json
{
  "type": "stream",
  "payload": {
    "text": "chunk of text",
    "requestId": "request-123",
    "accumulated": "full text so far"
  },
  "timestamp": 1708645200000
}
```

### 3. Channel Manager

Unified interface for managing multiple messaging platforms.

```typescript
import { ChannelManager, TelegramAdapter } from './comms';

const manager = new ChannelManager();

// Register Telegram
const telegram = new TelegramAdapter(process.env.TELEGRAM_BOT_TOKEN!);
manager.register(telegram);

// Set unified message handler
manager.setHandler(async (message) => {
  console.log(`[${message.channel}] ${message.from}: ${message.text}`);
  return `Received: ${message.text}`;
});

// Connect all channels
await manager.connectAll();

// Check status
console.log(manager.getStatus()); // { telegram: true }
```

### 4. Telegram Adapter (Functional)

Full implementation using Telegram Bot API with long polling.

```typescript
import { TelegramAdapter } from './comms/channels/telegram';

const telegram = new TelegramAdapter(process.env.TELEGRAM_BOT_TOKEN!);

telegram.onMessage(async (message) => {
  console.log(`Message from ${message.from}: ${message.text}`);
  return `Echo: ${message.text}`;
});

await telegram.connect();

// Send message
await telegram.sendMessage('CHAT_ID', 'Hello from J.A.R.V.I.S.!');
```

**Setup:**
1. Create bot via [@BotFather](https://t.me/botfather)
2. Get bot token
3. Set `TELEGRAM_BOT_TOKEN` environment variable

### 5. Voice I/O (Stubs)

Speech-to-Text and Text-to-Speech provider interfaces.

```typescript
import { WhisperSTT, LocalTTS } from './comms';

// STT - requires whisper.cpp setup
const stt = new WhisperSTT('http://localhost:8080');
// const text = await stt.transcribe(audioBuffer);

// TTS - requires ElevenLabs API or local TTS
const tts = new LocalTTS({ provider: 'elevenlabs', apiKey: '...' });
// const audio = await tts.synthesize('Hello world');
```

## Message Flow

### Incoming Message Flow
```
Telegram/Discord/etc
    ↓
ChannelAdapter.onMessage()
    ↓
ChannelHandler (unified)
    ↓
Business logic (in daemon)
    ↓
WebSocketServer.broadcast()
    ↓
All connected web clients
```

### LLM Streaming Flow
```
LLM Provider stream
    ↓
StreamRelay.relayStream()
    ↓
WebSocketServer.broadcast()
    ↓
Real-time updates to clients
```

## Running Examples

### Start WebSocket Server Only
```bash
bun run src/comms/example.ts
```

### With Telegram Integration
```bash
export TELEGRAM_BOT_TOKEN="your_bot_token"
bun run src/comms/example.ts
```

### Run Tests
```bash
bun test src/comms/websocket.test.ts
bun test src/comms/channels.test.ts
```

## Environment Variables

```bash
# Required for Telegram
TELEGRAM_BOT_TOKEN=1234567890:ABCdefGHIjklMNOpqrsTUVwxyz

# Future integrations
WHATSAPP_PHONE_ID=...
WHATSAPP_ACCESS_TOKEN=...
DISCORD_BOT_TOKEN=...
SIGNAL_PHONE=+1234567890
ELEVENLABS_API_KEY=...
```

## Channel Adapter Interface

All channel adapters implement this interface:

```typescript
interface ChannelAdapter {
  name: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendMessage(to: string, text: string, options?: SendOptions): Promise<void>; // { literal: true }: no markup, mentions or previews
  onMessage(handler: ChannelHandler): void;
  isConnected(): boolean;
}

type ChannelMessage = {
  id: string;
  channel: string;
  from: string;
  text: string;
  timestamp: number;
  metadata: Record<string, unknown>;
};

type ChannelHandler = (message: ChannelMessage) => Promise<string>;
```

## Future Channel Implementations

### WhatsApp
- Requires WhatsApp Business API setup
- Webhook-based architecture
- See: https://developers.facebook.com/docs/whatsapp/cloud-api

### Discord
- Use Discord Gateway WebSocket or discord.js
- Support slash commands
- See: https://discord.com/developers/docs

### Signal
- Requires signal-cli in daemon mode
- Local installation needed
- See: https://github.com/AsamK/signal-cli

## Integration with J.A.R.V.I.S. Daemon

```typescript
// In daemon/index.ts
import { WebSocketServer, ChannelManager, TelegramAdapter, StreamRelay } from './comms';
import { LLMRouter } from './llm';

const wsServer = new WebSocketServer();
const channels = new ChannelManager();
const streamRelay = new StreamRelay(wsServer);
const llmRouter = new LLMRouter();

// Unified message handler
channels.setHandler(async (message) => {
  // Route to appropriate LLM provider
  const stream = await llmRouter.route(message.text, { stream: true });

  // Relay stream to WebSocket clients
  const response = await streamRelay.relayStream(stream, message.id);

  // Return response to original channel
  return response;
});

// Start everything
wsServer.start();
if (process.env.TELEGRAM_BOT_TOKEN) {
  channels.register(new TelegramAdapter(process.env.TELEGRAM_BOT_TOKEN));
}
await channels.connectAll();
```

## Performance Considerations

- **WebSocket**: Bun's native WebSocket support is extremely fast
- **Telegram Polling**: Uses long polling (30s timeout) to minimize requests
- **Stream Relay**: Zero-copy broadcast to multiple clients
- **Memory**: Each WebSocket connection uses ~1KB of memory

## Security Notes

- **WebSocket**: Currently no authentication - add JWT or session tokens for production
- **Channel Tokens**: Store in environment variables, never commit
- **Rate Limiting**: Implement on message handlers to prevent abuse
- **Input Validation**: Always sanitize user input before processing

## Troubleshooting

### WebSocket Connection Failed
- Check port 3142 is not in use: `lsof -i :3142`
- Verify firewall allows connections
- Check CORS if connecting from browser

### Telegram Not Receiving Messages
- Verify bot token is correct
- Check bot is not blocked
- Ensure polling is active: check logs for "Starting polling"
- Test with `/health` endpoint

### Stream Not Broadcasting
- Verify WebSocket clients are connected: check `/health`
- Ensure LLM stream implements AsyncIterable<LLMStreamEvent>
- Check client WebSocket listeners are set up

## API Reference

See inline TypeScript documentation in each module for detailed API reference.
