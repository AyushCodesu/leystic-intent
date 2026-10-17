import { Brain, Layers, Users } from "lucide-react";
import { PillLinkTabs } from "@/components/PillLinkTabs";

export type InsightsTab = "themes" | "communities" | "learning";

type InsightsTabsProps = { active: InsightsTab; projectId: string };

const TABS = [
  { id: "themes" as const, label: "Pain themes", icon: <Layers className="size-4" aria-hidden="true" /> },
  { id: "communities" as const, label: "Communities", icon: <Users className="size-4" aria-hidden="true" /> },
  { id: "learning" as const, label: "Learned patterns", icon: <Brain className="size-4" aria-hidden="true" /> },
];

/** The two halves of Insights, as a pill strip that keeps the project in the URL. */
export function InsightsTabs({ active, projectId }: InsightsTabsProps) {
  return (
    <PillLinkTabs
      activeId={active}
      tabs={TABS.map((tab) => ({ ...tab, href: `/app/insights?project=${projectId}&tab=${tab.id}` }))}
    />
  );
}
