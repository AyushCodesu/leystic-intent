import { ArrowRightLeft, Heart, MessageSquare, ThumbsDown } from "lucide-react";
import { PillLinkTabs } from "@/components/PillLinkTabs";

export type CompetitorTab = "love" | "dislike" | "switchers" | "mentions";

type CompetitorTabsProps = {
  active: CompetitorTab;
  projectId: string;
  counts?: {
    love: number;
    dislike: number;
    switchers: number;
    mentions: number;
  };
};

export function CompetitorTabs({ active, projectId, counts }: CompetitorTabsProps) {
  const tabs = [
    {
      id: "love" as const,
      label: counts ? `What users love (${counts.love})` : "What users love",
      icon: <Heart className="size-4 text-emerald-500" aria-hidden="true" />,
    },
    {
      id: "dislike" as const,
      label: counts ? `What users dislike (${counts.dislike})` : "What users dislike",
      icon: <ThumbsDown className="size-4 text-rose-500" aria-hidden="true" />,
    },
    {
      id: "switchers" as const,
      label: counts ? `Potential switchers (${counts.switchers})` : "Potential switchers",
      icon: <ArrowRightLeft className="size-4 text-amber-500" aria-hidden="true" />,
    },
    {
      id: "mentions" as const,
      label: counts ? `All mentions (${counts.mentions})` : "All mentions",
      icon: <MessageSquare className="size-4" aria-hidden="true" />,
    },
  ];

  return (
    <PillLinkTabs
      activeId={active}
      tabs={tabs.map((tab) => ({
        ...tab,
        href: `/app/competitors?project=${projectId}&tab=${tab.id}`,
      }))}
    />
  );
}
