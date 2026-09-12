import type { GroupParticipantEvent, WhatsAppGateway } from '../../domain/ports.js';
import type { InboundMessage, OutboundMessage, SentMessage } from '../../domain/types.js';
import { AppError } from '../../common/errors.js';

export class ControlledWhatsAppGateway implements WhatsAppGateway {
  private readonly sendChains = new Map<string, Promise<void>>();
  private readonly lastSentAt = new Map<string, number>();
  public constructor(
    private readonly gateway: WhatsAppGateway,
    private readonly sendsEnabled: boolean,
    private readonly minimumIntervalMs = 750
  ) {}

  public connect(): Promise<void> {
    return this.gateway.connect();
  }

  public disconnect(reason?: string): Promise<void> {
    return this.gateway.disconnect(reason);
  }

  public listGroups(): Promise<Array<{ whatsappJid: string; name: string; participantCount: number }>> {
    return this.gateway.listGroups?.() ?? Promise.resolve([]);
  }

  public listGroupParticipants(groupJid: string): Promise<Array<{ jid: string; isAdmin: boolean }>> {
    return this.gateway.listGroupParticipants?.(groupJid) ?? Promise.resolve([]);
  }

  public isConnected(): boolean {
    return this.gateway.isConnected();
  }

  public async sendText(message: OutboundMessage): Promise<SentMessage> {
    if (!this.sendsEnabled) {
      throw new AppError('WHATSAPP_SEND_DISABLED', 'Outbound WhatsApp sending is disabled by configuration.', 503);
    }
    const previous = this.sendChains.get(message.chatJid) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const chain = previous.then(() => current);
    this.sendChains.set(message.chatJid, chain);
    await previous;
    try {
      const waitMs = Math.max(0, this.minimumIntervalMs - (Date.now() - (this.lastSentAt.get(message.chatJid) ?? 0)));
      if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
      const sent = await this.gateway.sendText(message);
      this.lastSentAt.set(message.chatJid, Date.now());
      return sent;
    } finally {
      release();
      if (this.sendChains.get(message.chatJid) === chain) this.sendChains.delete(message.chatJid);
    }
  }

  public setInboundHandler(handler: (message: InboundMessage) => Promise<void>): void {
    this.gateway.setInboundHandler?.(handler);
  }

  public setGroupParticipantHandler(handler: (event: GroupParticipantEvent) => Promise<void>): void {
    this.gateway.setGroupParticipantHandler?.(handler);
  }
}
