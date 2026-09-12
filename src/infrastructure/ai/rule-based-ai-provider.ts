import { parseNaturalDate } from '../../common/time.js';
import { inferPriority } from '../../common/recurrence.js';
import type { AICommandDraft, AICommandInput, AIProvider, AIReplyInput } from '../../domain/ports.js';

const cleanText = (value: string): string => value.replace(/\s+/g, ' ').trim();

const namesFrom = (value: string): string[] =>
  value
    .split(/,|\band\b|&/i)
    .map((name) => cleanText(name))
    .filter(Boolean);

/**
 * Safe local fallback. It intentionally extracts only high-confidence patterns;
 * a configured LLM can replace it through the same AIProvider interface.
 */
export class RuleBasedAIProvider implements AIProvider {
  public async extractCommand(input: AICommandInput): Promise<AICommandDraft> {
    const text = cleanText(input.text);
    const lower = text.toLowerCase();

    if (/\b(?:cancel|delete|stop)\b.*\btask\b|\btask\b.*\b(?:cancel|delete|stop)\b/.test(lower)) {
      return { intent: 'CANCEL_TASK', confidence: 0.95, needsClarification: false };
    }
    if (/\b(?:change|move|update|extend)\b.*\b(?:task|deadline|due|priority)\b/.test(lower)) {
      return { intent: 'UPDATE_TASK', confidence: 0.9, needsClarification: false };
    }

    let task = this.extractTask(text, input);
    if (!task && input.conversationHistory?.length) {
      const priorUser = [...input.conversationHistory].reverse().find((turn) => turn.role === 'user');
      const priorAssistant = [...input.conversationHistory].reverse().find((turn) => turn.role === 'assistant');
      if (priorUser && priorAssistant?.content.includes('?')) {
        const continuation = /deadline|when.*due/i.test(priorAssistant.content)
          ? `${priorUser.content} Deadline: ${text}`
          : `${priorUser.content} ${text}`;
        task = this.extractTask(continuation, input);
      }
    }
    if (task) return task;

    if (/\b(today'?s|daily)\b.*\breport\b|\breport\b.*\btoday\b/.test(lower)) {
      return { intent: 'REPORT_REQUEST', confidence: 0.99, needsClarification: false };
    }
    if (/\b(weekly|week)\b.*\breport\b|\breport\b.*\bweekly\b/.test(lower)) {
      return { intent: 'REPORT_REQUEST', confidence: 0.99, needsClarification: false };
    }

    if (/\b(?:write|draft|generate|compose|rewrite|create)\b.*\b(?:caption|content|copy|script|post|email|message|article|thread|proposal|bio|description|speech|outline)\b/i.test(text)) {
      return { intent: 'GENERATE_CONTENT', confidence: 0.9, needsClarification: false };
    }

    if (/\b(post|publish|announce)\b/.test(lower)) {
      const mentionStrategy = /\b(tag|mention)\s+(?:everybody|everyone|all)\b/.test(lower)
        ? 'EVERYONE'
        : /\b(officials only|tag officials)\b/.test(lower)
          ? 'OFFICIALS_ONLY'
          : 'NONE';
      const groupMatch = text.match(/\b(?:in|to)\s+(?:the\s+)?([\w -]+?\s+group)\b/i);
      const scheduleMatch = text.match(/\b(?:tomorrow|today|next\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))(?:\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?/i);
      return {
        intent: 'CREATE_ANNOUNCEMENT',
        confidence: groupMatch ? 0.75 : 0.5,
        needsClarification: !groupMatch,
        clarificationQuestion: groupMatch ? undefined : 'Which configured group should I post this in?',
        announcement: {
          body: text.replace(/^.*?\b(?:post|publish|announce)\b\s*/i, '').trim(),
          title: undefined,
          groupName: groupMatch?.[1],
          publishAtText: scheduleMatch?.[0],
          mentionStrategy,
          interestTags: []
        }
      };
    }

    if (/\b(opportunit(?:y|ies)|scholarship|grant|audition|competition|webinar)\b/.test(lower)) {
      return { intent: 'ASK_COMMUNITY_QUESTION', confidence: 0.8, needsClarification: false };
    }

    return { intent: 'GENERAL_CONVERSATION', confidence: 0.5, needsClarification: false };
  }

  public async draftReply(input: AIReplyInput): Promise<string> {
    return input.fallback;
  }

  private extractTask(text: string, input: AICommandInput): AICommandDraft | undefined {
    const patterns = [
      /\b(?:create|add|set(?:\s+up)?)\s+(?:a\s+)?task\s+for\s+(.+?)(?:\s*[:,-]\s*|\s+to\s+)(.+?)(?=\s+\b(?:by|before|due|deadline|post|publish)\b|[.!]|$)/i,
      /\b(?:assign|ask|tell)\s+(.+?)\s+to\s+(.+?)(?=\s+\b(?:by|before|due|deadline|post|publish)\b|[.!]|$)/i,
      /\b(?:give|assign)\s+(.+?)\s+(?:the|a|an)\s+(.+?)(?=\s+\b(?:by|before|due|deadline|post|publish)\b|[.!]|$)/i
    ];
    const match = patterns.map((pattern) => text.match(pattern)).find(Boolean);
    if (!match?.[1] || !match[2]) return undefined;
    const assigneeNames = namesFrom(match[1]);
    const title = cleanText(
      match[2]
        .replace(/^(?:task\s*(?::|-)?\s*(?:to\s+)?|to\s+)/i, '')
        .replace(/\s+task$/i, '')
    );
    if (!title) return undefined;
    const description = text.match(/\b(?:they\s+need\s+to|deliverables?\s*(?:are|:))\s+(.+?)(?=\s+\b(?:by|before|due)\b|[.!]|$)/i)?.[1];
    const deadlineText = text.match(/\b(?:by|before|due(?:\s+(?:on|by))?|deadline(?:\s*(?:is|:))?)\s+(.+?)(?=\s*[.!]|\s+\b(?:post|publish)\b|$)/i)?.[1];
    const publishText = text.match(/\b(?:post|publish)(?:\s+it)?(?:\s+in\s+(?:the\s+)?[\w -]+?\s+group)?\s+(.+?)(?=[.!]|$)/i)?.[1];
    const groupName = text.match(/\b(?:in|to)\s+(?:the\s+)?([\w -]+?\s+group)\b/i)?.[1]
    ?? input.defaultOfficialsGroupName;
    const deadlineAt = deadlineText ? parseNaturalDate(deadlineText, input.timezone, input.now) : undefined;
    const publishAt = publishText ? parseNaturalDate(publishText, input.timezone, input.now) : undefined;
    const unresolvedDate = Boolean((deadlineText && !deadlineAt) || (publishText && !publishAt));
    return {
      intent: 'CREATE_TASK',
      confidence: groupName && assigneeNames.length && title ? 0.87 : 0.6,
      needsClarification: !groupName || unresolvedDate,
      clarificationQuestion: !groupName
        ? 'Which configured officials group should receive this task?'
        : unresolvedDate
          ? 'Please confirm the date and time in a format such as Friday 5 PM.'
          : undefined,
      task: {
        title,
        description: cleanText(description ?? `Complete: ${title}.`),
        assigneeNames,
        groupName,
        publishAtText: publishText,
        deadlineAtText: deadlineText,
        priority: inferPriority(text)
      }
    };
  }
}
