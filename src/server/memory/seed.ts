import type { Citation, Source } from '../../shared/types.js';
import type { Db } from './db.js';
import { insertClaims, type NewClaim } from './claim-store.js';
import { addTurn, createConversation } from './turns.js';
import { addCivilDays, getZonedParts, partsAt, zonedToUtc } from '../agent/timezone.js';

interface SeedEvent {
  date: { year: number; month: number; day: number };
  hour: number;
  minute: number;
  user: string;
  answer: string;
  sources: Source[];
  claims: Array<Omit<NewClaim, 'turnId'>>;
}

function localPartsAt(date: { year: number; month: number; day: number }, hour: number, minute: number, tz: string): Date {
  return zonedToUtc(partsAt(date, hour, minute), tz);
}

function safeTime(date: Date, now: Date): Date {
  return date.getTime() > now.getTime() ? new Date(now.getTime() - 60_000) : date;
}

function mostRecentWeekday(
  now: Date,
  tz: string,
  target: string,
  strictlyBefore: boolean,
): { year: number; month: number; day: number } {
  const parts = getZonedParts(now, tz);
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const todayIndex = weekdays.indexOf(parts.weekday);
  const targetIndex = weekdays.indexOf(target);
  let daysBack = (todayIndex - targetIndex + 7) % 7;
  if (daysBack === 0 && strictlyBefore) daysBack = 7;
  return addCivilDays(parts, -daysBack);
}

function mostRecentNovemberThird(now: Date, tz: string): { year: number; month: number; day: number } {
  const parts = getZonedParts(now, tz);
  const thisYear = { year: parts.year, month: 11, day: 3 };
  const candidate = localPartsAt(thisYear, 9, 0, tz);
  if (candidate.getTime() > now.getTime()) {
    return { year: parts.year - 1, month: 11, day: 3 };
  }
  return thisYear;
}

function oldSource(
  url: string,
  title: string,
  content: string,
  publishedAt: string,
  id: string,
): Source {
  return {
    id,
    title,
    url,
    domain: 'demo.since.local',
    content,
    publishedAt,
    retrievedAt: publishedAt,
    demo: true,
  };
}

export function seedDemoHistory(
  db: Db,
  options: { timezone: string; now?: Date; title?: string },
): string {
  const now = options.now ?? new Date();
  const tz = options.timezone;
  const conversation = createConversation(db, {
    timezone: tz,
    title: options.title ?? 'CRM shortlist and Postgres hosting',
  });

  const nov3 = mostRecentNovemberThird(now, tz);
  const monday = mostRecentWeekday(now, tz, 'Mon', false);
  const lastTuesday = mostRecentWeekday(now, tz, 'Tue', true);

  const nov3Iso = localPartsAt(nov3, 0, 0, tz).toISOString().slice(0, 10);
  const mondayIso = localPartsAt(monday, 0, 0, tz).toISOString().slice(0, 10);
  const tuesdayIso = localPartsAt(lastTuesday, 0, 0, tz).toISOString().slice(0, 10);

  const postgresSources: Source[] = [
    oldSource(
      'https://demo.since.local/neon/launch-pricing',
      'Neon Launch plan pricing',
      'The Neon Launch plan costs $19 per month and includes 100 GB of storage and 300 compute hours. Neon bills compute usage beyond the included hours. Branching is available on all paid plans.',
      `${nov3Iso}T03:30:00.000Z`,
      'S1',
    ),
    oldSource(
      'https://demo.since.local/supabase/pro-plan',
      'Supabase Pro plan pricing',
      'The Supabase Pro plan costs $25 per month and includes 8 GB of database space, 100 GB of file storage, and 250 GB of egress. Add-ons are billed separately.',
      `${nov3Iso}T03:35:00.000Z`,
      'S2',
    ),
    oldSource(
      'https://demo.since.local/aws/rds-postgres-pricing',
      'Amazon RDS PostgreSQL pricing',
      'A db.t4g.medium PostgreSQL instance costs $0.068 per hour on demand in US East (N. Virginia). Automated backups are included for up to seven days. Multi-AZ doubles the instance cost.',
      `${nov3Iso}T03:40:00.000Z`,
      'S3',
    ),
  ];

  const crmSources: Source[] = [
    oldSource(
      'https://demo.since.local/hubspot/starter',
      'HubSpot Starter Customer Platform',
      'The HubSpot Starter Customer Platform costs $20 per seat per month. Breeze Copilot is in beta. At this tier, marketing, sales, and service tools share one contact record.',
      `${mondayIso}T03:30:00.000Z`,
      'S1',
    ),
    oldSource(
      'https://demo.since.local/salesforce/starter-suite',
      'Salesforce Starter Suite',
      'Salesforce Starter Suite costs $25 per user per month. Agentforce is available as a paid add-on rather than included in the suite. The suite includes Sales Cloud and Service Cloud Starter.',
      `${mondayIso}T03:32:00.000Z`,
      'S2',
    ),
    oldSource(
      'https://demo.since.local/pipedrive/essential',
      'Pipedrive Essential plan',
      'Pipedrive Essential costs $14 per user per month billed annually. The AI sales assistant is in beta. Growth is $29 per user per month and Professional is $49.',
      `${mondayIso}T03:35:00.000Z`,
      'S3',
    ),
    oldSource(
      'https://demo.since.local/zoho/standard',
      'Zoho CRM Standard plan',
      'Zoho CRM Standard costs $14 per user per month billed annually. Zia is available in higher tiers. Standard includes workflow automation, scoring rules, and mass email.',
      `${mondayIso}T03:38:00.000Z`,
      'S4',
    ),
    oldSource(
      'https://demo.since.local/close/base-plan',
      'Close base plan',
      'Close costs $29 per user per month on its base plan. Close does not currently include an AI inbox. Calling is built into the product and billed by usage.',
      `${mondayIso}T03:40:00.000Z`,
      'S5',
    ),
  ];

  const nov3Answer = `For a small managed Postgres deployment, here is the price comparison from the sources I checked:

**Neon** — Launch is **$19/month** with 100 GB storage and 300 compute hours [S1]. Compute beyond the included hours is usage-based.

**Supabase** — Pro is **$25/month** with 8 GB database space, 100 GB file storage, and 250 GB egress [S2]. Add-ons are separate.

**Amazon RDS** — A \`db.t4g.medium\` instance is **$0.068/hour** on demand, with seven days of automated backups [S3]. Multi-AZ doubles the instance cost.

For operational overhead, RDS gives you the most control and the most infrastructure to manage. Neon and Supabase are more turnkey. At this size, I would start with Neon or Supabase and only move to RDS if you need VPC-level control.`;

  const nov3BackupAnswer = `At this size, the catch with RDS is that “managed” still means you own more of the operational surface than with Neon or Supabase. Automated backups cover seven days by default [S3], but you should still verify restore procedures, set retention deliberately, and decide whether Multi-AZ is worth doubling the instance cost.

Neon and Supabase handle more of that for you, but both have usage-based edges: Neon bills compute beyond the included hours [S1], and Supabase bills add-ons and egress separately [S2]. For a side project, I would not choose RDS unless you specifically need its control or AWS integration.`;

  const crmAnswer = `Here is the shortlist comparison from the sources I checked:

| Vendor | Plan price | What stood out |
| --- | --- | --- |
| HubSpot | $20/seat/month [S1] | Breeze Copilot in beta; one contact record across hubs |
| Salesforce | $25/user/month [S2] | Agentforce is a paid add-on, not included |
| Pipedrive | $14/user/month [S3] | AI sales assistant in beta; Growth is $29 |
| Zoho CRM | $14/user/month [S4] | Zia is only in higher tiers |
| Close | $29/user/month [S5] | No AI inbox yet; calling is built in |

For a 20-person team, Pipedrive and Zoho are the price leaders, HubSpot is the most balanced, Salesforce is the most expensive once you add Agentforce, and Close is worth a look if outbound calling is central. I would ask each vendor for a 20-seat annual quote before deciding.`;

  const tuesdayAnswer = `Quick pricing check from the sources I checked:

- **Neon** — Launch is still **$19/month** with 100 GB storage and 300 compute hours [S1].
- **Supabase** — Pro is still **$25/month** with 8 GB database space and 250 GB egress [S2].
- **Amazon RDS** — \`db.t4g.medium\` is still **$0.068/hour** on demand with seven days of automated backups [S3].

Nothing in these sources shows a price change since 3 November.`;

  const nov3Claims: Array<Omit<NewClaim, 'turnId'>> = [
    {
      entity: 'Neon',
      attribute: 'pricing',
      value: '$19 per month (Launch plan, includes 100 GB storage and 300 compute hours)',
      asOf: nov3Iso,
      sourceUrl: postgresSources[0]!.url,
      quote: 'The Neon Launch plan costs $19 per month',
      volatility: 'high',
    },
    {
      entity: 'Supabase',
      attribute: 'pricing',
      value: '$25 per month (Pro plan, includes 8 GB database space and 250 GB egress)',
      asOf: nov3Iso,
      sourceUrl: postgresSources[1]!.url,
      quote: 'The Supabase Pro plan costs $25 per month',
      volatility: 'high',
    },
    {
      entity: 'Amazon RDS',
      attribute: 'pricing',
      value: '$0.068 per hour (db.t4g.medium, on demand, US East)',
      asOf: nov3Iso,
      sourceUrl: postgresSources[2]!.url,
      quote: 'A db.t4g.medium PostgreSQL instance costs $0.068 per hour on demand',
      volatility: 'high',
    },
  ];

  const backupClaims: Array<Omit<NewClaim, 'turnId'>> = [
    {
      entity: 'Amazon RDS',
      attribute: 'backup limits',
      value: 'Automated backups included for up to seven days by default',
      asOf: nov3Iso,
      sourceUrl: postgresSources[2]!.url,
      quote: 'Automated backups are included for up to seven days',
      volatility: 'medium',
    },
  ];

  const crmClaims: Array<Omit<NewClaim, 'turnId'>> = [
    {
      entity: 'HubSpot',
      attribute: 'pricing',
      value: '$20 per seat per month (Starter Customer Platform)',
      asOf: mondayIso,
      sourceUrl: crmSources[0]!.url,
      quote: 'The HubSpot Starter Customer Platform costs $20 per seat per month',
      volatility: 'high',
    },
    {
      entity: 'HubSpot',
      attribute: 'features',
      value: 'Breeze Copilot in beta',
      asOf: mondayIso,
      sourceUrl: crmSources[0]!.url,
      quote: 'Breeze Copilot is in beta',
      volatility: 'medium',
    },
    {
      entity: 'Salesforce',
      attribute: 'pricing',
      value: '$25 per user per month (Starter Suite)',
      asOf: mondayIso,
      sourceUrl: crmSources[1]!.url,
      quote: 'Salesforce Starter Suite costs $25 per user per month',
      volatility: 'high',
    },
    {
      entity: 'Salesforce',
      attribute: 'features',
      value: 'Agentforce available as a paid add-on',
      asOf: mondayIso,
      sourceUrl: crmSources[1]!.url,
      quote: 'Agentforce is available as a paid add-on',
      volatility: 'medium',
    },
    {
      entity: 'Pipedrive',
      attribute: 'pricing',
      value: '$14 per user per month (Essential, billed annually)',
      asOf: mondayIso,
      sourceUrl: crmSources[2]!.url,
      quote: 'Pipedrive Essential costs $14 per user per month billed annually',
      volatility: 'high',
    },
    {
      entity: 'Pipedrive',
      attribute: 'features',
      value: 'AI sales assistant in beta',
      asOf: mondayIso,
      sourceUrl: crmSources[2]!.url,
      quote: 'The AI sales assistant is in beta',
      volatility: 'medium',
    },
    {
      entity: 'Zoho CRM',
      attribute: 'pricing',
      value: '$14 per user per month (Standard, billed annually)',
      asOf: mondayIso,
      sourceUrl: crmSources[3]!.url,
      quote: 'Zoho CRM Standard costs $14 per user per month billed annually',
      volatility: 'high',
    },
    {
      entity: 'Zoho CRM',
      attribute: 'features',
      value: 'Zia available only in higher tiers',
      asOf: mondayIso,
      sourceUrl: crmSources[3]!.url,
      quote: 'Zia is available in higher tiers',
      volatility: 'medium',
    },
    {
      entity: 'Close',
      attribute: 'pricing',
      value: '$29 per user per month (base plan)',
      asOf: mondayIso,
      sourceUrl: crmSources[4]!.url,
      quote: 'Close costs $29 per user per month on its base plan',
      volatility: 'high',
    },
    {
      entity: 'Close',
      attribute: 'features',
      value: 'No AI inbox',
      asOf: mondayIso,
      sourceUrl: crmSources[4]!.url,
      quote: 'Close does not currently include an AI inbox',
      volatility: 'medium',
    },
  ];

  const tuesdayClaims: Array<Omit<NewClaim, 'turnId'>> = nov3Claims.map((claim) => ({
    ...claim,
    asOf: tuesdayIso,
  }));

  const events: SeedEvent[] = [
    {
      date: nov3,
      hour: 9,
      minute: 12,
      user:
        'I’m choosing managed Postgres for a side project. Compare Neon, Supabase, and Amazon RDS on price and operational overhead.',
      answer: nov3Answer,
      sources: postgresSources,
      claims: nov3Claims,
    },
    {
      date: nov3,
      hour: 9,
      minute: 24,
      user:
        'And what’s the catch with RDS at that size? I don’t want to babysit backups.',
      answer: nov3BackupAnswer,
      sources: postgresSources,
      claims: backupClaims,
    },
    {
      date: monday,
      hour: 10,
      minute: 5,
      user:
        'We’re a 20-person sales team and shortlisted five CRM tools: HubSpot, Salesforce, Pipedrive, Zoho CRM, and Close. Compare pricing and what’s new.',
      answer: crmAnswer,
      sources: crmSources,
      claims: crmClaims,
    },
  ];

  const sameDayAsNov3 =
    lastTuesday.year === nov3.year &&
    lastTuesday.month === nov3.month &&
    lastTuesday.day === nov3.day;
  if (!sameDayAsNov3) {
    events.push({
      date: lastTuesday,
      hour: 9,
      minute: 40,
      user: 'Quick check on Neon, Supabase, and RDS pricing before I decide.',
      answer: tuesdayAnswer,
      sources: postgresSources,
      claims: tuesdayClaims,
    });
  }

  events.sort(
    (a, b) =>
      localPartsAt(a.date, a.hour, a.minute, tz).getTime() -
      localPartsAt(b.date, b.hour, b.minute, tz).getTime(),
  );

  for (const event of events) {
    const createdAt = safeTime(localPartsAt(event.date, event.hour, event.minute, tz), now).toISOString();
    const userTurn = addTurn(db, {
      conversationId: conversation.id,
      role: 'user',
      text: event.user,
      createdAt,
      meta: { seed: true },
    });
    const answerAt = new Date(new Date(createdAt).getTime() + 8_000).toISOString();
    const assistantTurn = addTurn(db, {
      conversationId: conversation.id,
      role: 'assistant',
      text: event.answer,
      createdAt: answerAt,
      sources: event.sources,
      citations: event.sources.map((source): Citation => ({ sourceId: source.id })),
      latencyMs: 2_400,
      intent: 'fresh',
      meta: { seed: true, userTurnId: userTurn.id },
    });
    insertClaims(
      db,
      event.claims.map((claim, index) => ({
        ...claim,
        turnId: assistantTurn.id,
        createdAt: new Date(new Date(answerAt).getTime() + index).toISOString(),
      })),
    );
  }

  return conversation.id;
}
