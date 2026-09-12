import type { AppConfig } from '../../config/env.js';
import type { OperationsStore } from '../../domain/ports.js';
import type { Group, GroupMember, OfficialProfile, User } from '../../domain/types.js';
import { newId } from '../../common/ids.js';
import { z } from 'zod';

export const demoIds = {
  superAdmin: '00000000-0000-4000-8000-000000000001',
  david: '00000000-0000-4000-8000-000000000002',
  deborah: '00000000-0000-4000-8000-000000000003',
  precious: '00000000-0000-4000-8000-000000000004',
  officialsGroup: '00000000-0000-4000-8000-000000000011',
  communityGroup: '00000000-0000-4000-8000-000000000012'
} as const;

const bootstrapOfficialSchema = z.object({
  displayName: z.string().min(1),
  whatsappJid: z.string().regex(/^\d+@s\.whatsapp\.net$/),
  jobRole: z.string().min(1),
  department: z.string().min(1).optional(),
  capabilities: z.array(z.string().min(1)).default([]),
  interestTags: z.array(z.string().min(1)).default([])
});

type OfficialDefinition = z.infer<typeof bootstrapOfficialSchema> & { id: string };

const configuredOfficialDefinitions = (config: AppConfig): OfficialDefinition[] | undefined => {
  if (!config.BOOTSTRAP_OFFICIALS_JSON) return undefined;
  let input: unknown;
  try {
    input = JSON.parse(config.BOOTSTRAP_OFFICIALS_JSON);
  } catch {
    throw new Error('BOOTSTRAP_OFFICIALS_JSON must contain valid JSON.');
  }
  return z.array(bootstrapOfficialSchema).min(1).parse(input).map((official) => ({
    ...official,
    id: newId()
  }));
};

export const seedDemoData = async (store: OperationsStore, config: AppConfig): Promise<void> => {
  const now = new Date();
  const defaultOfficials: OfficialDefinition[] = [
    {
      id: demoIds.david,
      whatsappJid: '2348000000002@s.whatsapp.net',
      displayName: 'David',
      jobRole: 'Content',
      capabilities: ['caption', 'copywriting', 'content'],
      interestTags: ['music', 'opportunities']
    },
    {
      id: demoIds.deborah,
      whatsappJid: '2348000000003@s.whatsapp.net',
      displayName: 'Deborah',
      jobRole: 'Design',
      capabilities: ['graphic_design', 'flyer', 'social_graphic', 'poster'],
      interestTags: ['music', 'events']
    },
    {
      id: demoIds.precious,
      whatsappJid: '2348000000004@s.whatsapp.net',
      displayName: 'Precious',
      jobRole: 'Community',
      capabilities: ['community_engagement', 'outreach', 'announcements'],
      interestTags: ['scholarships', 'training']
    }
  ];
  const officialDefinitions = configuredOfficialDefinitions(config) ?? defaultOfficials;
  const desiredUsers: User[] = [
    {
      id: demoIds.superAdmin,
      whatsappJid: config.SUPER_ADMIN_WHATSAPP_JID,
      displayName: 'Super Admin',
      role: 'SUPER_ADMIN',
      active: true,
      createdAt: now,
      updatedAt: now
    },
    ...officialDefinitions.map((official) => ({
      id: official.id,
      whatsappJid: official.whatsappJid,
      phoneE164: `+${official.whatsappJid.split('@')[0]}`,
      displayName: official.displayName,
      interestTags: official.interestTags,
      role: 'OFFICIAL' as const,
      active: true,
      createdAt: now,
      updatedAt: now
    }))
  ];
  const users: User[] = [];
  for (const desired of desiredUsers) {
    const existing = await store.findUserByJid(desired.whatsappJid);
    users.push(existing ?? await store.createUser(desired));
  }
  const officials: OfficialProfile[] = officialDefinitions.map((official) => {
    const user = users.find((candidate) => candidate.whatsappJid === official.whatsappJid)!;
    return {
      userId: user.id,
      fullName: official.displayName,
      jobRole: official.jobRole,
      department: official.department,
      active: true,
      capabilities: official.capabilities ?? [official.jobRole.toLowerCase()],
      interestTags: official.interestTags
    };
  });
  for (const official of officials) await store.saveOfficial(official);
  const groups: Group[] = [
    {
      id: demoIds.officialsGroup,
      whatsappJid: config.OFFICIALS_GROUP_JID ?? '120363000000001@g.us',
      name: config.OFFICIALS_GROUP_NAME ?? 'Officials Group',
      type: 'OFFICIALS',
      active: true,
      timezone: config.ORGANIZATION_TIMEZONE,
      mentionAllMaxParticipants: 50,
      createdAt: now,
      updatedAt: now
    },
    {
      id: demoIds.communityGroup,
      whatsappJid: config.COMMUNITY_GROUP_JID ?? '120363000000002@g.us',
      name: config.COMMUNITY_GROUP_NAME ?? 'Hope Community Group',
      type: 'COMMUNITY',
      active: true,
      timezone: config.ORGANIZATION_TIMEZONE,
      mentionAllMaxParticipants: 150,
      createdAt: now,
      updatedAt: now
    }
  ];
  for (const group of groups) await store.saveGroup(group);
  const members: GroupMember[] = users.map((user) => ({
    groupId: demoIds.officialsGroup,
    userId: user.id,
    isAdmin: user.role === 'SUPER_ADMIN',
    active: true,
    lastSyncedAt: now
  }));
  await store.replaceGroupMembers(demoIds.officialsGroup, members);
  await store.replaceGroupMembers(
    demoIds.communityGroup,
    users.map((user) => ({
      groupId: demoIds.communityGroup,
      userId: user.id,
      isAdmin: user.role === 'SUPER_ADMIN',
      active: true,
      lastSyncedAt: now
    }))
  );
};
