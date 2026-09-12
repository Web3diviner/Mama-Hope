import { newId } from '../../common/ids.js';
import type { WhatsAppGateway } from '../../domain/ports.js';
import type { OutboundMessage, SentMessage } from '../../domain/types.js';

export class MemoryWhatsAppGateway implements WhatsAppGateway {
  private connected = false;
  public readonly sent: Array<OutboundMessage & SentMessage> = [];
  public readonly groupParticipants = new Map<string, Array<{ jid: string; isAdmin: boolean }>>();

  public async connect(): Promise<void> {
    this.connected = true;
  }

  public async disconnect(): Promise<void> {
    this.connected = false;
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public async listGroupParticipants(groupJid: string): Promise<Array<{ jid: string; isAdmin: boolean }>> {
    return structuredClone(this.groupParticipants.get(groupJid) ?? []);
  }

  public async sendText(message: OutboundMessage): Promise<SentMessage> {
    if (!this.connected) throw new Error('Memory WhatsApp gateway is disconnected.');
    const receipt: SentMessage = { id: `memory-${newId()}`, chatJid: message.chatJid, sentAt: new Date() };
    this.sent.push({
      ...structuredClone(message),
      media: message.media?.map((media) => ({ ...media, data: new Uint8Array(media.data) })),
      ...receipt
    });
    return receipt;
  }
}
