import type { ChannelAdapter, ChannelHandler, ChannelMessage, SendOptions } from './telegram.ts';

export class SignalAdapter implements ChannelAdapter {
  name = 'signal';
  private phone: string;
  private handler: ChannelHandler | null = null;
  private connected: boolean = false;

  constructor(config: { phone: string }) {
    this.phone = config.phone;
  }

  async connect(): Promise<void> {
    throw new Error(
      'Signal adapter not yet implemented. Requires signal-cli setup. ' +
      'Install signal-cli: https://github.com/AsamK/signal-cli'
    );

    // Future implementation would use signal-cli in daemon mode:
    // 1. Ensure signal-cli is installed and registered with phone number
    // 2. Start signal-cli in daemon mode with D-Bus interface
    // 3. Subscribe to message events via D-Bus
    // 4. Set this.connected = true
    //
    // Example using signal-cli REST API mode:
    // Start signal-cli with: signal-cli -a <PHONE> daemon --http localhost:8080
    // Then connect via HTTP API
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  // A real implementation must honour `options.literal` (no markup, mentions
  // or previews): the approval card is sent that way and approved by reply.
  async sendMessage(recipient: string, text: string, _options?: SendOptions): Promise<void> {
    throw new Error('Signal adapter not yet implemented.');

    // Future implementation using signal-cli REST API:
    // await fetch('http://localhost:8080/v2/send', {
    //   method: 'POST',
    //   headers: { 'Content-Type': 'application/json' },
    //   body: JSON.stringify({
    //     number: this.phone,
    //     recipients: [recipient],
    //     message: text,
    //   }),
    // });
  }

  onMessage(handler: ChannelHandler): void {
    this.handler = handler;
  }

  isConnected(): boolean {
    return this.connected;
  }
}
