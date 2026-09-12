import type { CreateCalendarEventInput, EventIntelligenceService } from '../../modules/events/event-intelligence.service.js';

interface GoogleEvent {
  id?: string;
  summary?: string;
  description?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
}

interface GoogleCalendarResponse { items?: GoogleEvent[] }

export class GoogleCalendarAdapter {
  public constructor(
    private readonly calendarId: string,
    private readonly accessToken: string,
    private readonly events: EventIntelligenceService
  ) {}

  public async sync(from: Date, to: Date): Promise<number> {
    const params = new URLSearchParams({
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime'
    });
    const response = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.calendarId)}/events?${params}`,
      { headers: { authorization: `Bearer ${this.accessToken}` }, signal: AbortSignal.timeout(15_000) }
    );
    if (!response.ok) throw new Error(`Google Calendar returned HTTP ${response.status}.`);
    const payload = await response.json() as GoogleCalendarResponse;
    let synced = 0;
    for (const item of payload.items ?? []) {
      const startsAt = item.start?.dateTime ?? item.start?.date;
      if (!item.id || !item.summary || !startsAt) continue;
      const input: CreateCalendarEventInput = {
        id: `google-${item.id}`,
        externalId: item.id,
        title: item.summary,
        description: item.description,
        startsAt: new Date(startsAt),
        endsAt: item.end?.dateTime || item.end?.date ? new Date(item.end.dateTime ?? item.end.date!) : undefined,
        timezone: item.start?.timeZone ?? 'Africa/Lagos',
        source: 'GOOGLE_CALENDAR',
        relevanceScore: this.relevance(item.summary)
      };
      await this.events.create(input);
      synced += 1;
    }
    return synced;
  }

  private relevance(title: string): number {
    return /music|musician|youth|child|education|creative|community|concert|workshop/i.test(title) ? 90 : 20;
  }
}