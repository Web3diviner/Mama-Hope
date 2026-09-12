import { formatDateTime, getLocalParts } from '../../common/time.js';
import type { OperationsStore } from '../../domain/ports.js';
import type { Announcement, Group, Task, TaskAssignee } from '../../domain/types.js';

export interface RenderedMessage {
  text: string;
  mentions: string[];
}

const bulletList = (value: string): string[] =>
  value
    .split(/\n|(?:^|[.;])\s*(?:•|-)/)
    .map((item) => item.trim().replace(/^[-•]\s*/, ''))
    .filter(Boolean);

const phoneMention = (jid: string | undefined, fallbackLabel: string): string => {
  const phone = jid?.split('@')[0]?.split(':')[0];
  return phone ? `@${phone}` : `@${fallbackLabel}`;
};

export class MessageRenderer {
  public constructor(
    private readonly store: OperationsStore,
    private readonly organizationTimezone: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  public async taskAssignment(task: Task, group: Group, assignees: TaskAssignee[]): Promise<RenderedMessage> {
    const people = await Promise.all(
      assignees.map(async (assignee) => {
        const [user, official] = await Promise.all([
          this.store.getUser(assignee.userId),
          this.store.getOfficial(assignee.userId)
        ]);
        return {
          label: official?.fullName ?? user?.displayName ?? 'Team member',
          jid: user?.whatsappJid
        };
      })
    );
    const assigneeLine = people
      .map((person) => `${person.label} (${phoneMention(person.jid, person.label)})`)
      .join(' ');
    const deliverables = bulletList(task.description);
    const deliverableLines = deliverables.length > 1
      ? `\n\nYou will be handling:\n${deliverables.map((item) => `• ${item}`).join('\n')}`
      : `\n\n${task.description}`;
    const deadline = task.deadlineAt
      ? `\n\n*Deadline:* ${formatDateTime(task.deadlineAt, group.timezone || this.organizationTimezone)}.`
      : '';

    return {
      text: [
        `${this.greeting(group.timezone || this.organizationTimezone)}, team.`,
        '',
        "Here's today's assignment.",
        '',
        `*${task.title}*`,
        '',
        assigneeLine,
        deliverableLines,
        deadline,
        '',
        'Please tag me when you have submitted your part so I can update our task record.',
        "You've got this."
      ].join('\n'),
      mentions: people.flatMap((person) => (person.jid ? [person.jid] : []))
    };
  }

  public async taskReminder(
    task: Task,
    group: Group,
    assignees: TaskAssignee[],
    minutesBefore: number
  ): Promise<RenderedMessage> {
    const people = await this.resolvePeople(assignees);
    const dueText = task.deadlineAt
      ? formatDateTime(task.deadlineAt, group.timezone || this.organizationTimezone)
      : 'the agreed deadline';
    const lead = minutesBefore >= 1440
      ? 'A gentle heads-up'
      : minutesBefore >= 360
        ? "We're getting closer to the deadline"
        : 'Quick check-in';
    const statusNote = assignees.some((assignee) => assignee.status === 'BLOCKED')
      ? '\n\nI have a blocker recorded. Let me know if it has changed or if the team needs to step in.'
      : assignees.some((assignee) => assignee.status === 'PENDING')
        ? '\n\nPlease acknowledge the assignment when you see this, and flag any blocker early.'
        : '\n\nHow are we looking? Share a quick progress update if you need support.';
    return {
      text: `${lead}, ${people.map((person) => `${person.label} (${phoneMention(person.jid, person.label)})`).join(' ')}.\n\n*${task.title}* is due ${dueText}.${statusNote}`,
      mentions: people.flatMap((person) => (person.jid ? [person.jid] : []))
    };
  }

  public async taskDeadline(task: Task, assignees: TaskAssignee[]): Promise<RenderedMessage> {
    const people = await this.resolvePeople(assignees);
    return {
      text: [
        `⏰ *${task.title}* has reached its deadline.`,
        '',
        `${people.map((person) => `${person.label} (${phoneMention(person.jid, person.label)})`).join(' ')} please update me with either:`,
        '',
        '*Completed*',
        'or',
        '*Blocked + reason*'
      ].join('\n'),
      mentions: people.flatMap((person) => (person.jid ? [person.jid] : []))
    };
  }

  public async announcement(
    announcement: Announcement,
    group: Group,
    mentionJids: string[]
  ): Promise<RenderedMessage> {
    const members = await Promise.all(mentionJids.map((jid) => this.store.findUserByJid(jid)));
    const labels = mentionJids.map((jid, index) => phoneMention(jid, members[index]?.displayName ?? 'member'));
    const heading = announcement.title ? `*${announcement.title}*\n\n` : '';
    const expiry = announcement.expiresAt
      ? `\n\n*Deadline:* ${formatDateTime(announcement.expiresAt, group.timezone || this.organizationTimezone)}`
      : '';
    return {
      text: `${heading}${announcement.body}${expiry}${labels.length ? `\n\n${labels.join(' ')}` : ''}`,
      mentions: mentionJids
    };
  }

  private async resolvePeople(assignees: TaskAssignee[]): Promise<Array<{ label: string; jid?: string }>> {
    return Promise.all(
      assignees.map(async (assignee) => {
        const [user, official] = await Promise.all([
          this.store.getUser(assignee.userId),
          this.store.getOfficial(assignee.userId)
        ]);
        return {
          label: official?.fullName ?? user?.displayName ?? 'Team member',
          jid: user?.whatsappJid
        };
      })
    );
  }

  private greeting(timeZone: string): string {
    const hour = getLocalParts(this.now(), timeZone).hour;
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';
    return 'Good evening';
  }
}
