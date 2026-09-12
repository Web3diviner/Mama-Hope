import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  normalizeMessageContent,
  useMultiFileAuthState,
  type AnyMessageContent,
  type WASocket,
  type WAMessage
} from '@whiskeysockets/baileys';
import { Agent } from 'node:https';
import type { Logger } from 'pino';
import { AppError } from '../../common/errors.js';
import type { GroupParticipantEvent, WhatsAppGateway } from '../../domain/ports.js';
import type { InboundMedia, InboundMessage, OutboundMedia, OutboundMessage, SentMessage } from '../../domain/types.js';

interface BaileysGatewayOptions {
  sessionDirectory: string;
  pairingPhone?: string;
  hostIp?: string;
  knownPhoneJids?: string[];
  connectTimeoutMs: number;
  logger: Logger;
}

type ContentInfo = {
  contextInfo?: { stanzaId?: string; mentionedJid?: string[]; participant?: string };
  caption?: string | null;
  text?: string | null;
  mimetype?: string | null;
  fileName?: string | null;
  fileLength?: number | null;
};

type MessageContent = {
  conversation?: string | null;
  extendedTextMessage?: ContentInfo;
  imageMessage?: ContentInfo;
  videoMessage?: ContentInfo;
  documentMessage?: ContentInfo;
  audioMessage?: ContentInfo;
};

/**
 * The only module that imports Baileys. Core operations depend on the
 * WhatsAppGateway interface and remain portable to a future official API.
 */
export class BaileysWhatsAppGateway implements WhatsAppGateway {
  private socket?: WASocket;
  private connected = false;
  private stopping = false;
  private connecting?: Promise<void>;
  private aliasRefresh?: Promise<void>;
  private readonly jidAliases = new Map<string, string>();
  private readonly messageCache = new Map<string, NonNullable<WAMessage['message']>>();
  private inboundHandler?: (message: InboundMessage) => Promise<void>;
  private groupParticipantHandler?: (event: GroupParticipantEvent) => Promise<void>;

  public constructor(private readonly options: BaileysGatewayOptions) {}

  public setInboundHandler(handler: (message: InboundMessage) => Promise<void>): void {
    this.inboundHandler = handler;
  }

  public setGroupParticipantHandler(handler: (event: GroupParticipantEvent) => Promise<void>): void {
    this.groupParticipantHandler = handler;
  }

  public async connect(): Promise<void> {
    if (this.socket || this.connecting) {
      await this.connecting;
      return;
    }
    this.stopping = false;
    this.connecting = this.openSocket();
    try {
      await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  public async disconnect(reason = 'shutdown'): Promise<void> {
    this.stopping = true;
    this.connected = false;
    this.socket?.end(new Error(reason));
    this.socket = undefined;
  }

  public async listGroups(): Promise<Array<{ whatsappJid: string; name: string; participantCount: number }>> {
    if (!this.socket || !this.connected) {
      throw new AppError('WHATSAPP_UNAVAILABLE', 'The WhatsApp bot is not connected.', 503);
    }
    const groups = await this.socket.groupFetchAllParticipating();
    return Object.entries(groups).map(([whatsappJid, group]) => ({
      whatsappJid,
      name: group.subject,
      participantCount: group.participants.length
    }));
  }

  public async listGroupParticipants(groupJid: string): Promise<Array<{ jid: string; isAdmin: boolean }>> {
    if (!this.socket || !this.connected) {
      throw new AppError('WHATSAPP_UNAVAILABLE', 'The WhatsApp bot is not connected.', 503);
    }
    const metadata = await this.socket.groupMetadata(groupJid);
    return metadata.participants.map((participant) => ({
      jid: this.resolveAlias(participant.id),
      isAdmin: participant.admin === 'admin' || participant.admin === 'superadmin'
    }));
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public async sendText(message: OutboundMessage): Promise<SentMessage> {
    const socket = this.socket;
    if (!socket || !this.connected) {
      throw new AppError('WHATSAPP_UNAVAILABLE', 'The WhatsApp bot is not connected.', 503);
    }
    if (message.media?.length) {
      for (const media of message.media) {
        const sent = await socket.sendMessage(
          message.chatJid,
          this.toMediaContent(media, undefined, undefined)
        );
        this.rememberMessage(sent);
        const id = sent?.key.id;
        if (!id) throw new AppError('WHATSAPP_SEND_FAILED', 'WhatsApp did not return a media message receipt.', 503);
      }
      const sent = await socket.sendMessage(message.chatJid, { text: message.text, mentions: message.mentions ?? [] });
      this.rememberMessage(sent);
      const id = sent?.key.id;
      if (!id) throw new AppError('WHATSAPP_SEND_FAILED', 'WhatsApp did not return an assignment message receipt.', 503);
      return { id, chatJid: message.chatJid, sentAt: new Date() };
    }
    const sent = await socket.sendMessage(message.chatJid, {
      text: message.text,
      mentions: message.mentions ?? []
    });
    this.rememberMessage(sent);
    const id = sent?.key.id;
    if (!id) throw new AppError('WHATSAPP_SEND_FAILED', 'WhatsApp did not return a message receipt.', 503);
    return { id, chatJid: message.chatJid, sentAt: new Date() };
  }

  private async openSocket(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.options.sessionDirectory);
    if (!state.creds.registered && state.creds.me) {
      // A pairing-code request writes a provisional `me` identity. It is not
      // reusable after that socket closes and would make the next connection
      // incorrectly attempt a login instead of a fresh registration.
      state.creds.me = undefined;
      state.creds.pairingCode = undefined;
      await saveCreds();
    }
    if (state.creds.me) this.rememberAliases(state.creds.me);
    const { version } = await fetchLatestBaileysVersion();
    const hostIp = this.options.hostIp;
    const agent = hostIp
      ? new Agent({
        lookup: (_hostname, lookupOptions, callback) => {
          if (typeof lookupOptions === 'object' && lookupOptions.all) {
            callback(null, [{ address: hostIp, family: 4 }]);
            return;
          }
          callback(null, hostIp, 4);
        }
      })
      : undefined;
    if (hostIp) {
      this.options.logger.warn({ hostIp }, 'Using a scoped WhatsApp DNS override');
    }
    const socket = makeWASocket({
      auth: state,
      version,
      agent,
      connectTimeoutMs: this.options.connectTimeoutMs,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      getMessage: async (key) => key.id ? this.messageCache.get(key.id) : undefined,
      logger: this.options.logger as unknown as Parameters<typeof makeWASocket>[0]['logger']
    });
    setTimeout(async () => {
  try {
    const groups = await socket.groupFetchAllParticipating();

    console.log("\n=== WHATSAPP GROUP JIDS ===");

    for (const [jid, group] of Object.entries(groups)) {
      console.log(`${group.subject} => ${jid}`);
    }

    console.log("===========================\n");
  } catch (error) {
    console.error("Failed to retrieve WhatsApp groups:", error);
  }
}, 10000);
    this.socket = socket;
    socket.ev.on('creds.update', () => {
      void saveCreds().catch((error: unknown) => this.options.logger.error({ err: error }, 'Unable to save WhatsApp session credentials'));
    });
    socket.ev.on('connection.update', (update) => {
      if (update.connection === 'open') {
        this.aliasRefresh = this.refreshKnownAliases(socket)
          .catch((error: unknown) => {
            this.options.logger.error({ err: error }, 'Unable to resolve known WhatsApp identity aliases');
          })
          .finally(() => {
            this.connected = true;
            this.options.logger.info({ aliases: this.jidAliases.size }, 'WhatsApp connection opened');
          });
        return;
      }
      if (update.connection !== 'close') return;
      this.connected = false;
      this.socket = undefined;
      const statusCode = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      this.options.logger.warn({ loggedOut, statusCode }, 'WhatsApp connection closed');
      if (!loggedOut && !this.stopping) {
        setTimeout(() => {
          void this.connect().catch((error: unknown) => this.options.logger.error({ err: error }, 'WhatsApp reconnect failed'));
        }, 2_000);
      }
    });
    socket.ev.on('messages.upsert', ({ messages, type }) => {
      for (const message of messages) {
        this.rememberMessage(message);
        if (type !== 'notify') continue;
        if (message.key.fromMe) continue;
        void this.normalizeInbound(message).then((inbound) => {
          if (!inbound || !this.inboundHandler) return;
          return this.inboundHandler(inbound).catch((error: unknown) => {
            this.options.logger.error({ err: error, messageId: inbound.id }, 'Inbound WhatsApp message processing failed');
          });
        }).catch((error: unknown) => {
          this.options.logger.error({ err: error, messageId: message.key.id }, 'Unable to normalize inbound WhatsApp message');
        });
      }
    });
    socket.ev.on('group-participants.update', (event) => {
      if (!this.groupParticipantHandler) return;
      if (!['add', 'invite', 'promote', 'demote', 'remove', 'leave'].includes(event.action)) return;
      void this.groupParticipantHandler({
        groupJid: event.id,
        participants: event.participants.map((participant) => this.resolveAlias(participant.id)),
        action: event.action as GroupParticipantEvent['action']
      }).catch((error: unknown) => {
        this.options.logger.error({ err: error, groupJid: event.id }, 'New group member welcome failed');
      });
    });
    socket.ev.on('contacts.upsert', (contacts) => {
      for (const contact of contacts) this.rememberAliases(contact);
    });
    socket.ev.on('contacts.update', (contacts) => {
      for (const contact of contacts) this.rememberAliases(contact);
    });
    socket.ev.on('messaging-history.set', ({ contacts, lidPnMappings }) => {
      for (const contact of contacts) this.rememberAliases(contact);
      for (const mapping of lidPnMappings ?? []) this.rememberAliases(mapping);
    });
    socket.ev.on('lid-mapping.update', ({ lid, pn }) => {
      this.rememberAliases({ lid, pn });
    });
    if (!state.creds.registered && this.options.pairingPhone) {
      // Wait until WhatsApp has accepted the registration handshake and sent
      // its QR challenge. Requesting a pairing code before this point mutates
      // `creds.me` too early and makes the handshake attempt an invalid login.
      await socket.waitForConnectionUpdate(
        async (update) => Boolean(update.qr),
        this.options.connectTimeoutMs
      );
      const code = await socket.requestPairingCode(this.options.pairingPhone);
      this.options.logger.warn({ pairingCode: code }, 'Use this one-time WhatsApp pairing code only from a secured operator console');
    }
  }

  private async normalizeInbound(message: WAMessage): Promise<InboundMessage | undefined> {
    await this.aliasRefresh;
    const id = message.key.id;
    const remoteJid = message.key.remoteJid;
    const senderCandidates = [
      message.key.participantAlt,
      message.key.participant,
      message.key.remoteJidAlt,
      remoteJid
    ].filter((jid): jid is string => Boolean(jid));
    const rawSenderJid = senderCandidates.find((jid) => jid.endsWith('@s.whatsapp.net')) ?? senderCandidates[0];
    if (!id || !remoteJid || !rawSenderJid) return undefined;
    const chatJid = remoteJid.endsWith('@g.us')
      ? remoteJid
      : this.resolveAlias(message.key.remoteJidAlt ?? remoteJid);
    const senderJid = this.resolveAlias(rawSenderJid);
    const content = (normalizeMessageContent(message.message) ?? {}) as unknown as MessageContent;
    const candidates: Array<ContentInfo | undefined> = [
      content.extendedTextMessage,
      content.imageMessage,
      content.videoMessage,
      content.documentMessage,
      content.audioMessage
    ];
    const info = candidates.find(Boolean);
    const text = content.conversation ?? info?.text ?? info?.caption ?? undefined;
    const media = await this.getMedia(message, content, info);
    const timestamp = typeof message.messageTimestamp === 'number'
      ? new Date(message.messageTimestamp * 1_000)
      : new Date();
    return {
      id,
      chatJid,
      senderJid,
      text: text ?? undefined,
      timestamp,
      quotedMessageId: info?.contextInfo?.stanzaId,
      quotedSenderJid: info?.contextInfo?.participant ? this.resolveAlias(info.contextInfo.participant) : undefined,
      mentions: (info?.contextInfo?.mentionedJid ?? []).map((jid) => this.resolveAlias(jid)),
      media
    };
  }

  private async refreshKnownAliases(socket: WASocket): Promise<void> {
    const knownPhoneJids = this.options.knownPhoneJids ?? [];
    if (!knownPhoneJids.length) return;
    await socket.onWhatsApp(...knownPhoneJids);
    const mappings = await socket.signalRepository.lidMapping.getLIDsForPNs(knownPhoneJids);
    for (const mapping of mappings ?? []) this.rememberAliases(mapping);
  }

  private rememberAliases(contact: { id?: string; jid?: string; phoneNumber?: string; pn?: string; lid?: string }): void {
    const phoneJid = contact.phoneNumber
      ?? contact.pn
      ?? contact.jid
      ?? (contact.id?.endsWith('@s.whatsapp.net') ? contact.id : undefined);
    const lid = contact.lid ?? (contact.id?.endsWith('@lid') ? contact.id : undefined);
    if (!phoneJid || !lid) return;
    const normalizedPhoneJid = jidNormalizedUser(phoneJid);
    const normalizedLid = jidNormalizedUser(lid);
    this.jidAliases.set(lid, normalizedPhoneJid);
    this.jidAliases.set(normalizedLid, normalizedPhoneJid);
    this.jidAliases.set(phoneJid, normalizedPhoneJid);
    this.jidAliases.set(normalizedPhoneJid, normalizedPhoneJid);
  }

  private resolveAlias(jid: string): string {
    const normalized = jidNormalizedUser(jid);
    return this.jidAliases.get(jid) ?? this.jidAliases.get(normalized) ?? normalized;
  }

  private rememberMessage(message: WAMessage | undefined): void {
    const id = message?.key.id;
    const content = message?.message;
    if (!id || !content) return;
    this.messageCache.set(id, content);
    if (this.messageCache.size <= 500) return;
    const oldest = this.messageCache.keys().next().value as string | undefined;
    if (oldest) this.messageCache.delete(oldest);
  }

  private async getMedia(message: WAMessage, content: MessageContent, info?: ContentInfo): Promise<InboundMedia | undefined> {
    const kind = content.imageMessage
      ? 'IMAGE'
      : content.videoMessage
        ? 'VIDEO'
        : content.audioMessage
          ? 'AUDIO'
          : content.documentMessage
            ? 'DOCUMENT'
            : undefined;
    if (!kind) return undefined;
    let data: Uint8Array | undefined;
    try {
      data = await downloadMediaMessage(message, 'buffer', {});
    } catch (error) {
      this.options.logger.warn({ err: error, messageId: message.key.id }, 'Unable to download inbound WhatsApp media');
    }
    return {
      kind,
      mimeType: info?.mimetype ?? undefined,
      fileName: info?.fileName ?? undefined,
      sizeBytes: info?.fileLength ?? undefined,
      data
    };
  }

  private toMediaContent(media: OutboundMedia, caption: string | undefined, mentions: string[] | undefined): AnyMessageContent {
    const common = { mimetype: media.mimeType, caption, mentions };
    const data = Buffer.from(media.data);
    switch (media.kind) {
      case 'IMAGE': return { image: data, ...common } as AnyMessageContent;
      case 'VIDEO': return { video: data, ...common } as AnyMessageContent;
      case 'AUDIO': return { audio: data, mimetype: media.mimeType, ptt: false } as AnyMessageContent;
      case 'DOCUMENT': return { document: data, ...common, fileName: media.fileName ?? 'attachment' } as AnyMessageContent;
      case 'LINK': return { text: caption ?? media.fileName ?? 'Attachment link', mentions } as AnyMessageContent;
    }
  }
}
