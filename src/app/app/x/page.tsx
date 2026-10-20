import { notFound } from "next/navigation";
import { XTab, type XParams } from "@/components/x/XTab";
import { requireLocalUser } from "@/lib/auth";
import { requireActiveProject } from "@/lib/projects";
import { config } from "@/lib/config";
import { getSourcePolicy, isSourceAuthorized } from "@/lib/sourcePolicy";

type XPageProps = { searchParams: Promise<XParams> };

/** The X tab: 404 when X_LEADS is off; explicit disabled state when pending/unauthorized; otherwise the project's X leads. */
export default async function XPage({ searchParams }: XPageProps) {
  const user = await requireLocalUser();
  if (!config().X_LEADS) {
    notFound();
  }
  const params = await searchParams;
  const project = await requireActiveProject(user.id, params.project);

  if (!isSourceAuthorized("x")) {
    const policy = getSourcePolicy("x");
    return (
      <div className="flex max-w-5xl flex-col gap-6">
        <div className="flex flex-col gap-1">
          <h1 className="text-h2" style={{ fontWeight: 500 }}>
            X Leads
          </h1>
          <p className="text-body text-fg-muted">
            X leads, buyer intent monitoring, and reply opportunities for {project.name}.
          </p>
        </div>
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-5 text-amber-200">
          <div className="flex items-center gap-2 font-medium text-amber-300">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-amber-400" />
            X / Twitter Source Authorization: {policy.status}
          </div>
          <p className="mt-2 text-sm text-amber-200/90 leading-relaxed">
            {policy.reason}
          </p>
          <p className="mt-2 text-xs text-amber-300/70">
            Under the technical fail-closed gate, X data ingestion, cache reuse, and serving are disabled while authorization status is {policy.status}. Refer to docs/source-authorization-register.md for required evidence.
          </p>
        </div>
      </div>
    );
  }

  return <XTab userId={user.id} project={project} params={params} />;
}
