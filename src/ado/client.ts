import { AdoWorkItem, AdoWorkItemReference, WiqlResult, AdoComment } from './types';

const GA_VERSION = '7.1';
const PREVIEW_VERSION = '7.1-preview.4';

export class AdoClient {
  private baseUrl: string;
  private headers: Record<string, string>;
  // Profile "me" lives on the vssps host (cloud) or the server root (on-prem).
  private profileBaseUrl: string;

  constructor(organization: string, pat: string, serverUrl?: string) {
    if (!organization || !pat) {
      throw new Error('AdoClient requires organization and PAT');
    }
    // Q2 resolution: serverUrl (on-prem ADO Server) wins when provided;
    // otherwise build the cloud URL from the org name.
    const trimmed = serverUrl?.trim();
    this.baseUrl = trimmed
      ? trimmed.replace(/\/+$/, '')
      : `https://dev.azure.com/${organization}`;
    // LIVE-TEST FIX: profile "me" lives on the vssps host for CLOUD orgs
    // (dev.azure.com / *.visualstudio.com); on-prem ADO Server keeps it under
    // the server root. Truthiness of serverUrl is NOT enough to tell them
    // apart — createServices always passes active.url, which falls back to
    // the cloud URL (https://dev.azure.com/{org}), so the old check sent
    // getMe() to dev.azure.com → 404 → Take Ownership always failed
    // (verified live: dev.azure.com/_apis/profile/profiles/me = 404,
    // vssps.dev.azure.com/... = 200). Match the HOST instead.
    let host = '';
    try { host = new URL(this.baseUrl).hostname; } catch { /* unparseable */ }
    const isCloud = !trimmed
      || host === 'dev.azure.com'
      || host.endsWith('.visualstudio.com');
    this.profileBaseUrl = isCloud
      ? `https://vssps.dev.azure.com/${organization}`
      : this.baseUrl;
    const encodedPat = Buffer.from(`:${pat}`).toString('base64');
    this.headers = {
      'Authorization': `Basic ${encodedPat}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
  }

  async getWorkItemsAssignedTo(
    project: string
  ): Promise<AdoWorkItem[]> {
    // Step 1: WIQL query to find assigned work items.
    // LIVE-TEST FIX (round 2): Azure WIQL does NOT scope by the project
    // segment in the URL — an org-level query returns items from ALL
    // projects. The previous @project-macro approach silently matched NOTHING
    // at the org-level endpoint (verified live: [System.AssignedTo] = @me →
    // 149 items; adding [System.TeamProject] = @project → 0). Interpolate the
    // project name as a WIQL string literal instead — single quotes doubled —
    // and keep the explicit [System.TeamProject] filter.
    const projectLiteral = project.replace(/'/g, "''");
    const wiqlQuery = {
      query: `SELECT [System.Id], [System.Title], [System.State], [System.WorkItemType], [System.AssignedTo], [System.Parent] FROM WorkItems WHERE [System.AssignedTo] = @me AND [System.TeamProject] = '${projectLiteral}' AND [System.State] <> 'Closed' AND [System.State] <> 'Done' ORDER BY [System.ChangedDate] DESC`
    };

    const wiqlResponse = await this.post<WiqlResult>(
      `/${project}/_apis/wit/wiql?api-version=7.1`,
      wiqlQuery
    );

    if (!wiqlResponse.workItems || wiqlResponse.workItems.length === 0) {
      return [];
    }

    // Step 2: Fetch full details for each work item (chunked — ADO 404s on
    // batch URLs with too many ids, e.g. ~688 ids ≈ 5.5KB URL).
    return this.fetchWorkItemsByIds(wiqlResponse.workItems.map(wi => wi.id));
  }

  /**
   * Batch-fetch work item details by id. Chunks to keep the URL short: ADO
   * returns 404 for oversized batch URLs (verified live: 688 ids ≈ 5.5KB URL
   * → 404; 100-id chunks work).
   */
  private async fetchWorkItemsByIds(ids: number[]): Promise<AdoWorkItem[]> {
    const results: AdoWorkItem[] = [];
    const CHUNK = 100;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK).join(',');
      const batchResponse = await this.get<{ value: AdoWorkItem[] }>(
        `/_apis/wit/workitems?ids=${chunk}&fields=System.Id,System.Title,System.State,System.AssignedTo,System.WorkItemType,System.Parent&api-version=7.1`
      );
      results.push(...(batchResponse.value || []));
    }
    return results;
  }

  /**
   * Open work items with NO assignee in the project — the "pickup pool" for
   * the Unassigned Work Items tree. Same WIQL-shape discipline as
   * getWorkItemsAssignedTo: literal project name (the @project macro silently
   * matches nothing at the org-level endpoint), unassigned = empty AssignedTo.
   */
  async getUnassignedWorkItems(project: string): Promise<AdoWorkItem[]> {
    const projectLiteral = project.replace(/'/g, "''");
    const wiqlQuery = {
      query: `SELECT [System.Id], [System.Title], [System.State], [System.WorkItemType], [System.AssignedTo], [System.Parent] FROM WorkItems WHERE [System.TeamProject] = '${projectLiteral}' AND [System.AssignedTo] = '' AND [System.State] <> 'Closed' AND [System.State] <> 'Done' ORDER BY [System.ChangedDate] DESC`
    };

    const wiqlResponse = await this.post<WiqlResult>(
      `/${project}/_apis/wit/wiql?api-version=7.1`,
      wiqlQuery
    );

    if (!wiqlResponse.workItems || wiqlResponse.workItems.length === 0) {
      return [];
    }

    return this.fetchWorkItemsByIds(wiqlResponse.workItems.map(wi => wi.id));
  }

  /**
   * People in the project (all project teams' members, deduped) for the
   * reassign picker. Org-level teams endpoint carries projectName; members
   * carry identity.uniqueName (email) which the AssignedTo PATCH accepts.
   */
  async getProjectTeamMembers(project: string): Promise<import('./types').AdoTeamMember[]> {
    const teams = await this.get<{ value: Array<{ id: string; projectId: string; projectName: string }> }>(
      `/_apis/teams?api-version=7.1`
    );
    const projectTeams = (teams.value || []).filter(t => t.projectName === project);

    const seen = new Set<string>();
    const members: import('./types').AdoTeamMember[] = [];
    for (const team of projectTeams) {
      try {
        const res = await this.get<{ value: Array<{ identity: { displayName: string; uniqueName: string } }> }>(
          `/_apis/projects/${team.projectId}/teams/${team.id}/members?api-version=7.1`
        );
        for (const m of res.value || []) {
          const { displayName, uniqueName } = m.identity || {};
          if (!uniqueName || seen.has(uniqueName)) continue;
          seen.add(uniqueName);
          members.push({ displayName: displayName || uniqueName, uniqueName });
        }
      } catch {
        // A team failing to list members shouldn't kill the whole picker.
      }
    }
    return members.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  /**
   * The authenticated user (for "Take Ownership"). Cloud: vssps profile API.
   * On-prem: best-effort profile endpoint under the server URL.
   */
  async getMe(): Promise<{ displayName: string; emailAddress: string }> {
    const url = `${this.profileBaseUrl}/_apis/profile/profiles/me?api-version=${GA_VERSION}`;
    const response = await this.fetchWithFallback(url, { headers: this.headers });
    return response.json() as Promise<{ displayName: string; emailAddress: string }>;
  }

  async getWorkItemDetail(
    project: string,
    workItemId: number
  ): Promise<AdoWorkItem> {
    return this.get<AdoWorkItem>(
      `/_apis/wit/workitems/${workItemId}?api-version=7.1`
    );
  }

  async addComment(
    project: string,
    workItemId: number,
    text: string
  ): Promise<AdoComment> {
    // LIVE-TEST FIX: the comments endpoint REQUIRES the project segment —
    // /_apis/wit/workitems/{id}/comments 404s, /{project}/_apis/wit/workItems/
    // {id}/comments returns 200 (verified live on zencomputersystems: ids 10,
    // 20, 100 → 404 without project, 200 with).
    return this.post<AdoComment>(
      `/${project}/_apis/wit/workItems/${workItemId}/comments?api-version=7.1-preview.4`,
      { text }
    );
  }

  /** List all projects in the organization the authenticated user has access to. */
  async getProjects(): Promise<import('./types').AdoProject[]> {
    const response = await this.get<{ value: import('./types').AdoProject[] }>(
      `/_apis/projects?stateFilter=WellFormed&api-version=7.1`
    );
    return response.value || [];
  }

  /**
   * States available for a work item TYPE in a project, in workflow order
   * (e.g. Task: Proposed → New → Active → Resolved → Closed → Removed).
   * Response shape: { count, value: [{ name, color, category }] } — category
   * is Proposed | InProgress | Completed | Removed.
   */
  async getWorkItemTypeStates(
    project: string,
    workItemType: string
  ): Promise<import('./types').AdoWorkItemTypeState[]> {
    const response = await this.get<{ value: import('./types').AdoWorkItemTypeState[] }>(
      `/${project}/_apis/wit/workitemtypes/${workItemType}/states?api-version=7.1`
    );
    return response.value || [];
  }

  async getComments(
    project: string,
    workItemId: number
  ): Promise<AdoComment[]> {
    // LIVE-TEST FIX: the ADO comments API returns { totalCount, count,
    // comments: [...] } — NOT { value: [...] } like most list endpoints.
    // Reading .value always yielded an empty thread (verified live: comment
    // posted with id 21076636 never appeared in getComments).
    const response = await this.get<{ comments: AdoComment[] }>(
      `/${project}/_apis/wit/workItems/${workItemId}/comments?api-version=7.1-preview.4`
    );
    return response.comments || [];
  }

  /** H1 fix: detail + discussion in one call (used by Tasks 13/21/28 — defined HERE in Task 7). */
  async getWorkItemWithDiscussion(project: string, workItemId: number): Promise<{
    detail: AdoWorkItem;
    comments: AdoComment[];
    creator?: { displayName: string; uniqueName: string };
  }> {
    const detail = await this.getWorkItemDetail(project, workItemId);
    const comments = await this.getComments(project, workItemId);
    return {
      detail,
      comments,
      creator: detail.fields['System.CreatedBy'],
    };
  }

  async updateWorkItem(
    project: string,
    workItemId: number,
    fields: Array<{ op: string; path: string; value: any }>
  ): Promise<any> {
    return this.patch(
      `/${project}/_apis/wit/workitems/${workItemId}?api-version=${GA_VERSION}`,
      fields,
      { 'Content-Type': 'application/json-patch+json' }
    );
  }

  private async get<T>(endpoint: string): Promise<T> {
    const url = this.buildUrl(endpoint);
    const response = await this.fetchWithFallback(url, { method: 'GET', headers: this.headers });
    return response.json() as Promise<T>;
  }

  private async post<T>(endpoint: string, body: any): Promise<T> {
    const url = this.buildUrl(endpoint);
    const response = await this.fetchWithFallback(url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });
    return response.json() as Promise<T>;
  }

  private async patch<T>(endpoint: string, body: any, headers?: Record<string, string>): Promise<T> {
    const url = this.buildUrl(endpoint);
    const response = await this.fetchWithFallback(url, {
      method: 'PATCH',
      headers: { ...this.headers, ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    return response.json() as Promise<T>;
  }

  /**
   * Build a full URL from a relative endpoint. If the endpoint already starts
   * with http, return it as-is (e.g. profileBaseUrl endpoints).
   */
  private buildUrl(endpoint: string): string {
    if (endpoint.startsWith('http')) return endpoint;
    return `${this.baseUrl}${endpoint}`;
  }

  /**
   * Universal ADO API fetch with GA→preview fallback.
   * Tries the GA version first. If the response contains the "preview flag
   * must be supplied" error, automatically retries with the preview version.
   * This handles the common case where an ADO org hasn't fully rolled out
   * GA for a specific endpoint.
   */
  private async fetchWithFallback(
    url: string,
    init: RequestInit,
    gaVersion = GA_VERSION,
    previewVersion = PREVIEW_VERSION,
  ): Promise<Response> {
    // Replace any existing api-version param with GA version
    const gaUrl = url.replace(/api-version=[^&]+/, `api-version=${gaVersion}`);
    let response = await fetch(gaUrl, init);

    if (!response.ok) {
      const text = await response.text();
      if (text.includes('-preview flag must be supplied')) {
        // Retry with preview version
        const previewUrl = url.replace(/api-version=[^&]+/, `api-version=${previewVersion}`);
        response = await fetch(previewUrl, init);
      } else {
        // Re-throw the original error (response body was consumed, so create a new error)
        throw new Error(`ADO API error: ${response.status} ${text}`);
      }
    }

    if (!response.ok) {
      throw new Error(`ADO API error: ${response.status} ${await response.text()}`);
    }

    return response;
  }
}
