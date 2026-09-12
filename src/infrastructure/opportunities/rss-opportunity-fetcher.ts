import { XMLParser } from 'fast-xml-parser';
import type { OpportunityIntelligenceService } from '../../modules/opportunities/opportunity-intelligence.service.js';
import { newId } from '../../common/ids.js';

interface FeedItem { title?: string; link?: string | { '@_href'?: string }; description?: string; summary?: string; pubDate?: string; published?: string }

export class RssOpportunityFetcher {
  private readonly parser = new XMLParser({ ignoreAttributes: false, trimValues: true });

  public constructor(private readonly opportunities: OpportunityIntelligenceService) {}

  public async fetch(url: string, sourceName: string): Promise<number> {
    const target = new URL(url);
    if (!['http:', 'https:'].includes(target.protocol) || this.isPrivateHost(target.hostname)) {
      throw new Error('Opportunity feed URL is not allowed.');
    }
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { accept: 'application/rss+xml, application/atom+xml, text/xml' } });
    if (!response.ok) throw new Error(`Opportunity feed returned HTTP ${response.status}.`);
    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (declaredLength > 5 * 1024 * 1024) throw new Error('Opportunity feed is too large.');
    const xml = await response.text();
    if (xml.length > 5 * 1024 * 1024) throw new Error('Opportunity feed is too large.');
    const parsed = this.parser.parse(xml) as { rss?: { channel?: { item?: FeedItem | FeedItem[] } }; feed?: { entry?: FeedItem | FeedItem[] } };
    const rawItems = parsed.rss?.channel?.item ?? parsed.feed?.entry ?? [];
    const items = Array.isArray(rawItems) ? rawItems : [rawItems];
    let ingested = 0;
    for (const item of items) {
      const link = typeof item.link === 'string' ? item.link : item.link?.['@_href'];
      if (!item.title || !link) continue;
      const summary = String(item.description ?? item.summary ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      await this.opportunities.ingest({
        id: newId(),
        sourceName,
        sourceUrl: link,
        title: item.title,
        summary: summary || item.title,
        category: /grant|fund/i.test(`${item.title} ${summary}`) ? 'Grant' : 'Opportunity',
        musicRelevance: /music|artist|creative|song|perform/i.test(`${item.title} ${summary}`) ? 95 : 25,
        regionalRelevance: /africa|nigeria|african/i.test(`${item.title} ${summary}`) ? 90 : 30,
        youthRelevance: /youth|young|student/i.test(`${item.title} ${summary}`) ? 80 : 30,
        supportValue: /grant|fund|scholarship|award/i.test(`${item.title} ${summary}`) ? 85 : 30,
        sourceCredibility: 70
      });
      ingested += 1;
    }
    return ingested;
  }

  private isPrivateHost(hostname: string): boolean {
    const host = hostname.toLowerCase();
    if (host === 'localhost' || host === '::1' || host.endsWith('.local')) return true;
    if (/^127\.|^10\.|^192\.168\.|^169\.254\./.test(host)) return true;
    const match = host.match(/^172\.(\d+)\./);
    return Boolean(match?.[1] && Number(match[1]) >= 16 && Number(match[1]) <= 31);
  }
}
