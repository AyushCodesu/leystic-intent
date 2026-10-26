import { deleteProject } from "@/lib/projects";
import { RETENTION_DAYS } from "@/lib/tiers";
import { xEnabledFor } from "@/lib/x/enabled";
import { isSourceAuthorized, type SourceOperationRequest } from "@/lib/sourcePolicy";

const REDDIT_API_LEADS_OP: SourceOperationRequest = {
  sourceId: "reddit",
  purpose: "commercial_lead_generation",
  scope: "social_content_read",
};

const REDDIT_API_SEO_OP: SourceOperationRequest = {
  sourceId: "reddit",
  purpose: "seo_opportunity_discovery",
  scope: "social_content_read",
};
import type { ApiCaller } from "./auth";
import { parseLeadQuery } from "./leadsQuery";
import { getApiLead, listApiLeads } from "./leadsRead";
import { requestsToday } from "./limit";
import { ApiError } from "./responses";
import {
  getApiProject,
  listApiPainThemes,
  listApiProjects,
  listApiSeoOpportunities,
  projectUsageToday,
  requireProject,
} from "./resources";

/**
 * One function per endpoint, returning plain JSON. The REST routes and the MCP
 * tools both call these, so an agent and a script see the same answer.
 */

function feedWindowDays(caller: ApiCaller): number {
  return caller.limits?.feedWindowDays ?? RETENTION_DAYS;
}

/**
 * The tier limits as the API has always shown them. X leads' limits are shown
 * only to a caller X is on for, so a feature that ships dark stays dark here.
 * public/openapi.json's TierLimits is held to this by tests/apiContract.test.ts.
 */
export function publicLimits(caller: ApiCaller) {
  if (!caller.limits || xEnabledFor(caller.user.id)) {
    return caller.limits;
  }
  const rest: Partial<typeof caller.limits> = { ...caller.limits };
  delete rest.x;
  const presses: Partial<typeof caller.limits.actions.presses> = { ...caller.limits.actions.presses };
  delete presses.x_scan_now;
  return { ...rest, actions: { ...caller.limits.actions, presses } };
}

export async function me(caller: ApiCaller) {
  return {
    user: {
      id: caller.user.id,
      email: caller.user.email,
      createdAt: caller.user.createdAt.toISOString(),
    },
    tier: caller.tier,
    selfHosted: caller.selfHosted,
    limits: publicLimits(caller),
    key: { prefix: caller.keyPrefix, scopes: caller.scopes },
    requestsToday: await requestsToday(caller.keyId),
    requestsPerDay: caller.limits?.apiRequestsPerDay ?? null,
  };
}

export async function projects(caller: ApiCaller) {
  return { projects: await listApiProjects(caller.user.id) };
}

export async function project(caller: ApiCaller, projectId: string) {
  const row = await requireProject(caller.user.id, projectId);
  return { project: await getApiProject(row) };
}

export async function deleteProjectHandler(caller: ApiCaller, projectId: string) {
  const result = await deleteProject(caller.user.id, projectId);
  if (!result.deleted) {
    throw new ApiError("not_found", "No project with that id.");
  }
  return { deleted: true, id: projectId };
}

export async function projectLeads(
  caller: ApiCaller,
  projectId: string,
  params: URLSearchParams,
) {
  if (!isSourceAuthorized(REDDIT_API_LEADS_OP)) {
    throw new ApiError(
      "source_disabled",
      "Reddit data source is disabled: commercial authorization is missing or pending review.",
    );
  }
  const row = await requireProject(caller.user.id, projectId);
  return listApiLeads(row.id, parseLeadQuery(params), feedWindowDays(caller));
}

export async function lead(caller: ApiCaller, leadId: string) {
  if (!isSourceAuthorized(REDDIT_API_LEADS_OP)) {
    throw new ApiError(
      "source_disabled",
      "Reddit data source is disabled: commercial authorization is missing or pending review.",
    );
  }
  const found = await getApiLead(caller.user.id, leadId);
  if (!found) {
    throw new ApiError("not_found", "No lead with that id.");
  }
  return { lead: found };
}

export async function projectSeoOpportunities(caller: ApiCaller, projectId: string) {
  if (!isSourceAuthorized(REDDIT_API_SEO_OP)) {
    throw new ApiError(
      "source_disabled",
      "Reddit SEO opportunity tracking is disabled: commercial authorization is missing or pending review.",
    );
  }
  const row = await requireProject(caller.user.id, projectId);
  return { opportunities: await listApiSeoOpportunities(row.id) };
}

export async function projectPainThemes(caller: ApiCaller, projectId: string) {
  if (!isSourceAuthorized(REDDIT_API_LEADS_OP)) {
    throw new ApiError(
      "source_disabled",
      "Pain themes derived from Reddit are disabled: commercial authorization is missing or pending review.",
    );
  }
  const row = await requireProject(caller.user.id, projectId);
  return { themes: await listApiPainThemes(row.id) };
}

export async function projectUsage(caller: ApiCaller, projectId: string) {
  const row = await requireProject(caller.user.id, projectId);
  return { usage: await projectUsageToday(row.id) };
}
