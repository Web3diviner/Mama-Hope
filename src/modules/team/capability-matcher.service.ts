import type { OperationsStore } from '../../domain/ports.js';
import type { OfficialProfile, User } from '../../domain/types.js';

export interface CapabilityRecommendation {
  user: User;
  profile: OfficialProfile;
  activeTaskCount: number;
  capabilityScore: number;
}

const normalize = (value: string): string => value.trim().toLocaleLowerCase().replace(/[\s-]+/g, '_');

const tokens = (value: string): Set<string> => new Set(
  value
    .toLocaleLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 2)
);

export class CapabilityMatcherService {
  public constructor(private readonly store: OperationsStore) {}

  public async recommend(requirement: string, limit = 10): Promise<CapabilityRecommendation[]> {
    const requestedTokens = tokens(requirement);
    const [officials, activeTasks] = await Promise.all([
      this.store.listOfficials(),
      this.store.listTasks()
    ]);
    const assignments = await this.store.listTaskAssigneesForTasks(activeTasks.map((task) => task.id));
    const activeTaskIds = new Set(activeTasks.filter((task) => ['SCHEDULED', 'ACTIVE', 'OVERDUE'].includes(task.status)).map((task) => task.id));
    const recommendations = await Promise.all(officials
      .filter(({ user, profile }) => user.active && profile.active)
      .map(async ({ user, profile }) => {
        const capabilityValues = [
          ...profile.capabilities,
          profile.jobRole ?? '',
          profile.department ?? '',
          ...profile.interestTags
        ];
        const capabilityTokens = new Set(capabilityValues.flatMap((value) => [...tokens(value), normalize(value)]));
        const matchedTokens = [...requestedTokens].filter((token) => capabilityTokens.has(token));
        const activeTaskCount = assignments.filter((assignment) => assignment.userId === user.id && activeTaskIds.has(assignment.taskId)).length;
        return {
          user,
          profile,
          activeTaskCount,
          capabilityScore: matchedTokens.length
        };
      }));
    return recommendations
      .sort((left, right) => right.capabilityScore - left.capabilityScore || left.activeTaskCount - right.activeTaskCount || left.profile.fullName.localeCompare(right.profile.fullName))
      .slice(0, Math.max(1, Math.min(limit, 50)));
  }
}
