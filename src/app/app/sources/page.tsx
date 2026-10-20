import { Suspense } from "react";
import { PlanSections } from "@/components/product/PlanSections";
import { ListSkeleton } from "@/components/Skeleton";
import { requireLocalUser } from "@/lib/auth";
import { requireActiveProject } from "@/lib/projects";
import { getSourcePolicy } from "@/lib/sourcePolicy";

type SourcesPageProps = { searchParams: Promise<{ project?: string }> };

/**
 * Where a scan looks: the searches, the communities and the competitors that
 * discovery wrote, apart from the product page, which is what the scorer is told.
 */
export default async function SourcesPage({ searchParams }: SourcesPageProps) {
  const user = await requireLocalUser();
  const project = await requireActiveProject(user.id, (await searchParams).project);
  const redditPolicy = getSourcePolicy("reddit");

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-h2" style={{ fontWeight: 500 }}>
          Sources
        </h1>
        <p className="text-body text-fg-muted">
          Where lurk looks for your buyers on Reddit.
        </p>
      </div>
      {!redditPolicy.enabled && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-amber-200">
          <div className="flex items-center gap-2 font-medium text-amber-300">
            <span className="inline-block h-2 w-2 rounded-full bg-amber-400" />
            Reddit Discovery and Scanning Inactive
          </div>
          <p className="mt-1 text-sm text-amber-200/80 leading-relaxed">
            Live searches, subreddit listings, and profile scans are disabled under the source authorization gate. Configured sources will not be queried until a valid commercial agreement is authorized.
          </p>
        </div>
      )}
      <Suspense fallback={<ListSkeleton rows={5} />}>
        <PlanSections projectId={project.id} userId={user.id} />
      </Suspense>
    </div>
  );
}
