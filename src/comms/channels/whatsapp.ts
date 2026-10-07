import type { ChannelAdapter, ChannelHandler, ChannelMessage, SendOptions } from './telegram.ts';

export class WhatsAppAdapter implements ChannelAdapter {
  name = 'whatsapp';
  private phoneNumberId: string;
  private accessToken: string;
  private handler: ChannelHandler | null = null;
  private connected: boolean = false;

  constructor(config: { phoneNumberId: string; accessToken: string }) {
    this.phoneNumberId = config.phoneNumberId;
    this.accessToken = config.accessToken;
  }

  async connect(): Promise<void> {
    throw new Error(
      'WhatsApp adapter not yet implemented. Requires WhatsApp Business API setup. ' +
      'Visit https://developers.facebook.com/docs/whatsapp/cloud-api/get-started'
    );

    // Future implementation would:
    // 1. Set up webhook endpoint for incoming messages
    // 2. Verify webhook with Facebook/Meta
    // 3. Start listening for webhook events
    // 4. Set this.connected = true
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  // A real implementation must honour `options.literal` (no markup, mentions
  // or previews): the approval card is sent that way and approved by reply.
  // WhatsApp renders *bold*, _italic_ and ~strike~ with no escape, so literal
  // text there needs more than a flag.
  async sendMessage(to: string, text: string, _options?: SendOptions): Promise<void> {
    throw new Error('WhatsApp adapter not yet implemented.');

    // Future implementation:
    // const response = await fetch(
    //   `https://graph.facebook.com/v18.0/${this.phoneNumberId}/messages`,
    //   {
    //     method: 'POST',
    //     headers: {
    //       'Authorization': `Bearer ${this.accessToken}`,
    //       'Content-Type': 'application/json',
    //     },
    //     body: JSON.stringify({
    //       messaging_product: 'whatsapp',
    //       to,
    //       text: { body: text },
    //     }),
    //   }
    // );
  }

  onMessage(handler: ChannelHandler): void {
    this.handler = handler;
  }

  isConnected(): boolean {
    return this.connected;
  }
}
