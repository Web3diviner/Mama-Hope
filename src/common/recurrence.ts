import { addLocalDays, getLocalParts, localDateTimeToUtc } from './time.js';
import type { PriorityLevel, TaskRecurrence } from '../domain/types.js';

const weekdayIndexes: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6
};

const clockFromRecurrence = (text: string): { hour: number; minute: number } => {
  const match = text.toLowerCase().match(
    /(?:every|each|daily|weekly|monthly|weekdays?).{0,45}?\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/
  );
  if (!match?.[1]) return { hour: 9, minute: 0 };
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const meridiem = match[3];
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return { hour: 9, minute: 0 };
  return { hour, minute };
};

export const inferPriority = (text: string, supplied?: PriorityLevel): PriorityLevel => {
  if (/\b(?:urgent|asap|immediately|critical|emergency|right away|today)\b/i.test(text)) return 'URGENT';
  if (/\b(?:high priority|important|priority|launch|client-facing|time-sensitive|soon)\b/i.test(text)) return 'HIGH';
  if (/\b(?:low priority|whenever|no rush)\b/i.test(text)) return 'LOW';
  return supplied ?? 'NORMAL';
};

export const parseTaskRecurrence = (
  text: string,
  timeZone: string,
  reference: Date
): { recurrence: Omit<TaskRecurrence, 'deadlineOffsetMinutes'>; firstRunAt: Date } | undefined => {
  if (/\b(?:once|one[- ]?time|only this time|do not repeat|don'?t repeat|not recurring)\b/i.test(text)) return undefined;
  if (!/\b(?:every|each|daily|weekly|monthly|weekdays?)\b/i.test(text)) return undefined;

  const lower = text.toLowerCase();
  const frequency: TaskRecurrence['frequency'] = /\b(?:monthly|every month|each month)\b/.test(lower)
    ? 'MONTHLY'
    : /\b(?:weekly|every week|each week|weekdays?|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(lower)
      ? 'WEEKLY'
      : 'DAILY';
  const interval = Math.max(1, Number(lower.match(/every\s+(\d+)\s+(?:days?|weeks?|months?)/)?.[1] ?? 1));
  const namedWeekdays = Object.entries(weekdayIndexes)
    .filter(([name]) => new RegExp(`\\b${name}\\b`, 'i').test(text))
    .map(([, index]) => index);
  const local = getLocalParts(reference, timeZone);
  const weekdays = /\bweekdays?\b/i.test(text)
    ? [1, 2, 3, 4, 5]
    : namedWeekdays.length
      ? namedWeekdays
      : frequency === 'WEEKLY'
        ? [local.weekday]
        : [];
  const ordinal = lower.match(/\bon\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\b/);
  const requestedDay = ordinal?.[1] ? Number(ordinal[1]) : local.day;
  const dayOfMonth = frequency === 'MONTHLY' && requestedDay >= 1 && requestedDay <= 31 ? requestedDay : undefined;
  const clock = clockFromRecurrence(text);
  const recurrence = {
    frequency,
    interval,
    weekdays,
    dayOfMonth,
    localHour: clock.hour,
    localMinute: clock.minute
  };
  return { recurrence, firstRunAt: nextRecurrenceAt(recurrence, new Date(reference.getTime() - 60_000), timeZone) };
};

export const nextRecurrenceAt = (
  recurrence: Omit<TaskRecurrence, 'deadlineOffsetMinutes'> | TaskRecurrence,
  after: Date,
  timeZone: string
): Date => {
  const local = getLocalParts(after, timeZone);
  if (recurrence.frequency === 'DAILY') {
    for (let days = 0; days <= recurrence.interval; days += 1) {
      const candidateParts = addLocalDays(local, days);
      const candidate = localDateTimeToUtc({
        ...candidateParts,
        hour: recurrence.localHour,
        minute: recurrence.localMinute
      }, timeZone);
      if (candidate > after && (days === 0 || days === recurrence.interval)) return candidate;
    }
  }
  if (recurrence.frequency === 'WEEKLY') {
    for (let days = 0; days <= 7 * recurrence.interval; days += 1) {
      const candidateParts = addLocalDays(local, days);
      if (!recurrence.weekdays.includes(candidateParts.weekday)) continue;
      const candidate = localDateTimeToUtc({
        ...candidateParts,
        hour: recurrence.localHour,
        minute: recurrence.localMinute
      }, timeZone);
      if (candidate > after) return candidate;
    }
  }
  const baseMonth = new Date(Date.UTC(local.year, local.month - 1, 1));
  for (let monthOffset = 0; monthOffset <= recurrence.interval; monthOffset += 1) {
    const month = new Date(Date.UTC(baseMonth.getUTCFullYear(), baseMonth.getUTCMonth() + monthOffset, 1));
    const finalDay = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate();
    const candidate = localDateTimeToUtc({
      year: month.getUTCFullYear(),
      month: month.getUTCMonth() + 1,
      day: Math.min(recurrence.dayOfMonth ?? local.day, finalDay),
      hour: recurrence.localHour,
      minute: recurrence.localMinute
    }, timeZone);
    if (candidate > after && (monthOffset === 0 || monthOffset === recurrence.interval)) return candidate;
  }
  throw new Error('Unable to calculate the next recurrence.');
};

export const inferDeadlineAt = (
  publishAt: Date,
  priority: PriorityLevel,
  recurringFrequency?: TaskRecurrence['frequency']
): Date => {
  const priorityMinutes: Record<PriorityLevel, number> = {
    URGENT: 4 * 60,
    HIGH: 24 * 60,
    NORMAL: 48 * 60,
    LOW: 72 * 60
  };
  const recurringMaximum = recurringFrequency === 'DAILY'
    ? 8 * 60
    : recurringFrequency === 'WEEKLY'
      ? 48 * 60
      : 72 * 60;
  const minutes = recurringFrequency
    ? Math.min(priorityMinutes[priority], recurringMaximum)
    : priorityMinutes[priority];
  return new Date(publishAt.getTime() + minutes * 60_000);
};
