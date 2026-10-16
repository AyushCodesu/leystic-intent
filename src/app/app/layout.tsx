import { headers } from "next/headers";
import { ActivityPoll } from "@/components/ActivityPoll";
import { hasWorkInFlight } from "@/lib/projectActivity";
import { Header } from "@/components/Header";
import { ProjectSwitcher } from "@/components/ProjectSwitcher";
import { ProjectSync } from "@/components/ProjectSync";
import { Rail, type RailGroup } from "@/components/Rail";
import { requireLocalUser } from "@/lib/auth";
import { countMentions } from "@/lib/competitors/read";
import { newLeadCount } from "@/lib/leads";
import { listProjects, pickProject } from "@/lib/projects";
import { countOpportunities } from "@/lib/seo/read";
import { xEnabledFor } from "@/lib/x/enabled";
import { newXLeadCount } from "@/lib/x/read";
import { URL_HEADER } from "@/proxy";

/** `newXLeads` is null when X leads is off for this user, which also hides its item. */
type RailCounts = { newLeads: number; rankingThreads: number; mentions: number; newXLeads: number | null };

const groupsFor = (counts: RailCounts): RailGroup[] => [
  {
    label: "Overview",
    items: [
      { href: "/app/leads", label: "Leads", icon: "radar", count: counts.newLeads },
      { href: "/app/product", label: "Product", icon: "box" },
      { href: "/app/competitors", label: "Competitors", icon: "swords", count: counts.mentions },
      { href: "/app/insights", label: "Insights", icon: "lightbulb" },
      { href: "/app/usage", label: "Usage", icon: "receipt" },
      { href: "/app/settings", label: "Settings", icon: "settings" },
    ],
  },
];

const EMPTY_COUNTS: RailCounts = { newLeads: 0, rankingThreads: 0, mentions: 0, newXLeads: null };

/**
 * What the rail's pills count for the project on screen: leads waiting, threads
 * Google ranks, and competitor mentions inside the mention window.
 */
async function countsFor(projectId: string, showX: boolean): Promise<RailCounts> {
  const [newLeads, rankingThreads, mentions, newXLeads] = await Promise.all([
    newLeadCount(projectId),
    countOpportunities(projectId),
    countMentions(projectId),
    showX ? newXLeadCount(projectId) : null,
  ]);
  return { newLeads, rankingThreads, mentions, newXLeads };
}

/** The project the page below is showing, which the rail has to count for. */
async function requestedProject(): Promise<string | undefined> {
  const url = (await headers()).get(URL_HEADER);
  return (url ? new URL(url).searchParams.get("project") : null) ?? undefined;
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireLocalUser();
  const [requested, projects] = await Promise.all([requestedProject(), listProjects(user.id)]);
  const project = pickProject(projects, requested);
  const showX = xEnabledFor(user.id);
  const [counts, busy] = project
    ? await Promise.all([countsFor(project.id, showX), hasWorkInFlight(project.id)])
    : [{ ...EMPTY_COUNTS, newXLeads: showX ? 0 : null }, false];
  return (
    <div className="flex min-h-dvh flex-col">
      <Header />
      {/* Here and not on each page: the rail's counts and every tab are filled
          by jobs that finish after the page was drawn. */}
      <ActivityPoll busy={busy} />
      <ProjectSync drawnFor={requested ?? ""} />
      <div className="flex flex-1">
        <Rail groups={groupsFor(counts)} projectId={project?.id ?? null}>
          <ProjectSwitcher
            projects={projects.map((one) => ({ id: one.id, name: one.name, url: one.url }))}
            defaultId={project?.id ?? null}
          />
        </Rail>
        {/*
          min-w-0 or the page grows to its widest content: a flex item's own
          minimum is its max-content width, so one long Reddit body made the
          whole app 5,246px wide in a 1,440px window and the people strip's
          own horizontal scroll never engaged.
        */}
        <main className="min-w-0 flex-1" style={{ padding: "var(--page-gutter)" }}>
          {children}
        </main>
      </div>
    </div>
  );
}
