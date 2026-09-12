const weekdayIndexes: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6
};

const partNumber = (parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): number => {
  const value = parts.find((part) => part.type === type)?.value;
  if (!value) {
    throw new Error(`Missing ${type} time component.`);
  }
  return Number(value);
};

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

export const getLocalParts = (date: Date, timeZone: string): LocalParts => {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
    weekday: 'short'
  });
  const parts = formatter.formatToParts(date);
  const weekdayText = parts.find((part) => part.type === 'weekday')?.value.toLowerCase();
  const weekday = weekdayText ? ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(weekdayText.slice(0, 3)) : -1;
  if (weekday < 0) {
    throw new Error('Unable to resolve weekday.');
  }
  return {
    year: partNumber(parts, 'year'),
    month: partNumber(parts, 'month'),
    day: partNumber(parts, 'day'),
    hour: partNumber(parts, 'hour'),
    minute: partNumber(parts, 'minute'),
    weekday
  };
};

export const getTimeZoneOffsetMinutes = (date: Date, timeZone: string): number => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset'
  }).formatToParts(date);
  const text = parts.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT';
  const match = text.match(/^GMT(?:(\+|-)(\d{2}):(\d{2}))?$/);
  if (!match || !match[1] || !match[2] || !match[3]) {
    return 0;
  }
  const sign = match[1] === '+' ? 1 : -1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
};

export const localDateTimeToUtc = (
  local: Pick<LocalParts, 'year' | 'month' | 'day' | 'hour' | 'minute'>,
  timeZone: string
): Date => {
  const provisional = new Date(Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute));
  const offset = getTimeZoneOffsetMinutes(provisional, timeZone);
  return new Date(provisional.getTime() - offset * 60_000);
};

export const addLocalDays = (parts: LocalParts, days: number): LocalParts => {
  const value = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, parts.hour, parts.minute));
  return {
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
    day: value.getUTCDate(),
    hour: parts.hour,
    minute: parts.minute,
    weekday: (parts.weekday + days + 7) % 7
  };
};

export const parseClockTime = (value: string): { hour: number; minute: number } | undefined => {
  const match = value.trim().toLowerCase().match(/(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (!match || !match[1]) {
    return undefined;
  }
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? '0');
  const meridiem = match[3];
  if (minute > 59 || hour > 23 || hour < 0) {
    return undefined;
  }
  if (meridiem) {
    if (hour > 12 || hour === 0) {
      return undefined;
    }
    if (meridiem === 'pm' && hour !== 12) {
      hour += 12;
    }
    if (meridiem === 'am' && hour === 12) {
      hour = 0;
    }
  }
  return { hour, minute };
};

export const parseNaturalDate = (
  input: string,
  timeZone: string,
  reference = new Date()
): Date | undefined => {
  const normalized = input.trim().toLowerCase().replaceAll(',', ' ');
  const local = getLocalParts(reference, timeZone);
  const clock = parseClockTime(normalized) ?? { hour: 9, minute: 0 };

  if (normalized.includes('tomorrow')) {
    return localDateTimeToUtc({ ...addLocalDays(local, 1), ...clock }, timeZone);
  }
  if (normalized.includes('today')) {
    const candidate = localDateTimeToUtc({ ...local, ...clock }, timeZone);
    return candidate.getTime() >= reference.getTime() ? candidate : undefined;
  }
  const weekdayName = Object.keys(weekdayIndexes).find((weekday) => normalized.includes(weekday));
  if (weekdayName) {
    const requestedWeekday = weekdayIndexes[weekdayName];
    const current = local.weekday;
    let daysAhead = (requestedWeekday - current + 7) % 7;
    if (normalized.includes('next ') || daysAhead === 0) {
      daysAhead += 7;
    }
    return localDateTimeToUtc({ ...addLocalDays(local, daysAhead), ...clock }, timeZone);
  }
  const iso = new Date(input);
  return Number.isNaN(iso.getTime()) ? undefined : iso;
};

export const formatDateTime = (date: Date, timeZone: string): string =>
  new Intl.DateTimeFormat('en-NG', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short'
  }).format(date);

export const moveIntoWorkingHours = (
  date: Date,
  timeZone: string,
  startHour = 8,
  endHour = 20
): Date => {
  const local = getLocalParts(date, timeZone);
  if (local.hour >= startHour && local.hour < endHour) return date;
  const target = local.hour < startHour ? local : addLocalDays(local, 1);
  return localDateTimeToUtc({ ...target, hour: startHour, minute: 0 }, timeZone);
};

export const isDue = (date: Date, now = new Date()): boolean => date.getTime() <= now.getTime();
