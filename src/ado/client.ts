import { AdoWorkItem, WiqlResult, AdoComment } from './types';
import { markdownToHtml } from './markdownToHtml';

const GA_VERSION = '7.1';
const PREVIEW_VERSION = '7.1-preview.4';

/** Max walk rounds per direction for hierarchy expansion (ADO hierarchies are shallow). */
const MAX_HIERARCHY_ROUNDS = 8;

/**
 * Read the parent work item id from a fetched work item, tolerating both
 * shapes ADO is known to serialize `System.Parent` in: `{ id: number }`
 * (cloud) and a bare integer/string (some orgs/servers flatten link fields).
 * Returns undefined when there is no readable parent.
 */
export function parentIdOf(fields: Record<string, unknown>): number | undefined {
  const p = fields['System.Parent'];
  if (p == null) return undefined;
  let id: number | undefined;
  if (typeof p === 'object') {
    const raw = (p as { id?: unknown }).id;
    id = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : undefined;
  } else {
    id = Number(p);
  }
  return id !== undefined && Number.isFinite(id) && id > 0 ? id : undefined;
}

/**
 * ADO states that mean "no more work to do" on an item — used to filter a
 * delegated parent's delivery checklist and to skip already-finished children
 * during post-run auto-completion.
 */
const TERMINAL_STATES: ReadonlySet<string> = new Set(['Closed', 'Done', 'Resolved', 'Removed']);

export function isTerminalState(state?: string): boolean {
  return !!state && TERMINAL_STATES.has(state);
}

/**
 * The ADO state a completed item should move to, by work item type:
 * Task/Bug/Impediment → Closed; Story/Feature/Epic/PBI → Resolved.
 */
export function terminalStateForType(workItemType: string): string {
  return /task|bug|impediment/i.test(workItemType) ? 'Closed' : 'Resolved';
}

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
   * ALL open work items in the project (any assignee, plus unassigned) —
   * the "All Work Items" tree mode. Same WIQL-shape discipline as the other
   * two queries: literal project name, no AssignedTo filter, Closed/Done out.
   */
  async getAllWorkItems(project: string): Promise<AdoWorkItem[]> {
    const projectLiteral = project.replace(/'/g, "''");
    const wiqlQuery = {
      query: `SELECT [System.Id], [System.Title], [System.State], [System.WorkItemType], [System.AssignedTo], [System.Parent] FROM WorkItems WHERE [System.TeamProject] = '${projectLiteral}' AND [System.State] <> 'Closed' AND [System.State] <> 'Done' ORDER BY [System.ChangedDate] DESC`
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
   * Fetch child work items (tasks under a parent) via WIQL.
   * Returns work items whose System.Parent matches the given parentId.
   * Used by delegate_to_agent to include child tasks in the agent context.
   */
  async getChildWorkItems(project: string, parentId: number): Promise<AdoWorkItem[]> {
    const projectLiteral = project.replace(/'/g, "''");
    const wiqlQuery = {
      query: `SELECT [System.Id], [System.Title], [System.State], [System.WorkItemType], [System.AssignedTo] FROM WorkItems WHERE [System.TeamProject] = '${projectLiteral}' AND [System.Parent] = ${parentId} ORDER BY [System.Id] ASC`
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
   * Expand a flat work item set into a hierarchy closure so tree views can
   * render proper nesting:
   *   UP   — fetch missing parents (Task → User Story → Feature → Epic), so
   *          items become children of their real parents even when those
   *          parents weren't in the base set (e.g. assigned to someone else).
   *   DOWN — fetch children of every item in the growing set via
   *          `[System.Parent] IN (...)` (the WIQL-recommended parent filter),
   *          so a Feature shows its User Stories and a Story its Tasks.
   * Each direction is bounded by MAX_HIERARCHY_ROUNDS and terminates early
   * when no new items appear. Base items are always included unchanged.
   */
  async expandHierarchy(project: string, baseItems: AdoWorkItem[]): Promise<AdoWorkItem[]> {
    const byId = new Map<number, AdoWorkItem>();
    for (const wi of baseItems) byId.set(wi.id, wi);
    const projectLiteral = project.replace(/'/g, "''");

    // ── UP: ancestors ──
    for (let round = 0; round < MAX_HIERARCHY_ROUNDS; round++) {
      const missing = new Set<number>();
      for (const wi of byId.values()) {
        const pid = parentIdOf(wi.fields as Record<string, unknown>);
        if (pid !== undefined && !byId.has(pid)) missing.add(pid);
      }
      if (missing.size === 0) break;
      const fetched = await this.fetchWorkItemsByIds([...missing]);
      let added = 0;
      for (const wi of fetched) {
        if (!byId.has(wi.id)) {
          byId.set(wi.id, wi);
          added++;
        }
      }
      if (added === 0) break; // parents vanished / unreadable — stop walking
    }

    // ── DOWN: descendants (children, grandchildren, …) ──
    const queriedForChildren = new Set<number>();
    for (let round = 0; round < MAX_HIERARCHY_ROUNDS; round++) {
      const parents = [...byId.values()]
        .map(wi => wi.id)
        .filter(id => !queriedForChildren.has(id));
      if (parents.length === 0) break;
      for (const p of parents) queriedForChildren.add(p);

      // Chunk the IN list so the WIQL body stays modest on huge sets.
      const newIds = new Set<number>();
      try {
        for (let i = 0; i < parents.length; i += 300) {
          const chunk = parents.slice(i, i + 300).join(',');
          const wiqlResponse = await this.post<WiqlResult>(
            `/${project}/_apis/wit/wiql?api-version=7.1`,
            { query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${projectLiteral}' AND [System.Parent] IN (${chunk}) ORDER BY [System.Id] ASC` }
          );
          for (const ref of wiqlResponse.workItems || []) {
            if (!byId.has(ref.id)) newIds.add(ref.id);
          }
        }
      } catch {
        // Some ADO orgs reject IN on System.Parent — fall back to the
        // live-proven per-parent equality query ([System.Parent] = N).
        for (const pid of parents) {
          try {
            const wiqlResponse = await this.post<WiqlResult>(
              `/${project}/_apis/wit/wiql?api-version=7.1`,
              { query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${projectLiteral}' AND [System.Parent] = ${pid} ORDER BY [System.Id] ASC` }
            );
            for (const ref of wiqlResponse.workItems || []) {
              if (!byId.has(ref.id)) newIds.add(ref.id);
            }
          } catch {
            // A single parent failing shouldn't abort the whole walk.
          }
        }
      }
      if (newIds.size === 0) continue; // nothing new at this depth — next round has no work either
      const fetched = await this.fetchWorkItemsByIds([...newIds]);
      for (const wi of fetched) {
        if (!byId.has(wi.id)) byId.set(wi.id, wi);
      }
    }

    return [...byId.values()];
  }

  /**
   * All descendant work items (children, grandchildren, …) of a parent, as a
   * flat list ordered by id. Reuses expandHierarchy's DOWN walk, then keeps
   * only items whose parent chain actually reaches parentId (ancestors and
   * the parent itself are excluded). Used when delegating a parent work item
   * so the agent's delivery checklist covers the whole subtree.
   */
  async getDescendantWorkItems(project: string, parentId: number): Promise<AdoWorkItem[]> {
    const parent = (await this.fetchWorkItemsByIds([parentId]))[0];
    if (!parent) return [];
    const closure = await this.expandHierarchy(project, [parent]);
    const byId = new Map(closure.map(wi => [wi.id, wi] as const));
    const descendants: AdoWorkItem[] = [];
    for (const wi of closure) {
      if (wi.id === parentId) continue;
      // Walk the parent chain up to see whether this item hangs under parentId.
      let found = false;
      let cur: AdoWorkItem | undefined = wi;
      for (let depth = 0; depth < 32; depth++) {
        const pid = parentIdOf(cur.fields as Record<string, unknown>);
        if (pid === undefined) break;
        if (pid === parentId) { found = true; break; }
        cur = byId.get(pid);
        if (!cur) break; // parent outside the closure — can't confirm ancestry
      }
      if (found) descendants.push(wi);
    }
    return descendants.sort((a, b) => a.id - b.id);
  }

  /** Fetch work items by id (public wrapper around the private by-ids fetch). */
  async getWorkItemsByIds(ids: number[]): Promise<AdoWorkItem[]> {
    return this.fetchWorkItemsByIds(ids);
  }

  /**
   * People in the project (all project teams' members, deduped) for the
   * reassign picker. Org-level teams endpoint carries projectName; members
   * carry identity.uniqueName (email) which the AssignedTo PATCH accepts.
   * Falls back to project-level teams endpoint if org-level returns no results.
   */
  async getProjectTeamMembers(project: string): Promise<import('./types').AdoTeamMember[]> {
    const seen = new Set<string>();
    const members: import('./types').AdoTeamMember[] = [];

    // Primary: org-level teams endpoint (works for most organizations)
    try {
      const teams = await this.get<{ value: Array<{ id: string; projectId: string; projectName: string }> }>(
        `/_apis/teams?api-version=7.1`
      );
      const projectTeams = (teams.value || []).filter(t => t.projectName === project);
      
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
    } catch {
      // Org-level teams endpoint failed, will try project-level fallback below.
    }

    // Fallback: project-level teams endpoint (if org-level returned no members)
    if (members.length === 0) {
      try {
        const teams = await this.get<{ value: Array<{ id: string; name: string }> }>(
          `/_apis/projects/${encodeURIComponent(project)}/teams?api-version=7.1`
        );
        for (const team of teams.value || []) {
          try {
            const res = await this.get<{ value: Array<{ identity: { displayName: string; uniqueName: string } }> }>(
              `/_apis/projects/${encodeURIComponent(project)}/teams/${team.id}/members?api-version=7.1`
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
      } catch {
        // Project-level teams endpoint also failed, return empty array.
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
    _project: string,
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

  // ── Rich-text images ────────────────────────────────────────────────

  // Cap on inlined images per HTML blob: the resulting data URLs ride the
  // webview postMessage, so keep them bounded.
  private static readonly MAX_IMAGES_PER_HTML = 10;
  private static readonly MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2 MB each
  private static readonly MAX_TOTAL_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB per call

  /**
   * Rewrite `<img>` tags whose src points at an ADO attachment endpoint into
   * inline `data:` URLs so webview-rendered rich text can display them (the
   * raw attachment URLs require authentication a webview cannot attach).
   *
   * - Only fetches images same-origin with the configured ADO host; other
   *   URLs (external images, already-embedded data URLs) are left untouched.
   * - Failed fetches leave the original src in place (image shows as broken,
   *   but the rest of the field renders normally).
   * - Capped (10 images / 2 MB each / 8 MB total); overflow images keep their
   *   original src.
   * - Verified live against zencomputersystems: the rich-text src
   *   (`/.../_apis/wit/attachments/{id}?fileName=...`, project-ID based)
   *   returns 200 with the bytes under Basic auth; content-type comes back
   *   like `image/jpeg; api-version=7.1` (server appends the api-version
   *   param — strip everything after `;`).
   */
  async resolveImagesInHtml(html: string): Promise<string> {
    if (!html || !html.includes('<img')) return html;
    let baseOrigin: string;
    try {
      baseOrigin = new URL(this.baseUrl).origin;
    } catch {
      return html;
    }

    // Collect (whole tag, src) pairs for every <img ...>.
    const imgTagRe = /<img\b[^>]*>/gi;
    const srcAttrRe = /\bsrc\s*=\s*["']([^"']+)["']/i;
    const wanted: Array<{ tag: string; src: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = imgTagRe.exec(html)) !== null) {
      const sm = m[0].match(srcAttrRe);
      if (!sm) continue;
      const src = sm[1];
      if (src.startsWith('data:')) continue;
      let url: URL;
      try {
        url = new URL(src, this.baseUrl);
      } catch {
        continue;
      }
      if (url.origin !== baseOrigin) continue;
      wanted.push({ tag: m[0], src });
      if (wanted.length >= AdoClient.MAX_IMAGES_PER_HTML) break;
    }
    if (wanted.length === 0) return html;

    // Fetch each unique src (parallel), respecting the size caps.
    const srcToDataUrl = new Map<string, string>();
    let totalBytes = 0;
    await Promise.all([...new Set(wanted.map(w => w.src))].map(async (src) => {
      if (totalBytes >= AdoClient.MAX_TOTAL_IMAGE_BYTES) return;
      const dataUrl = await this.fetchAttachmentAsDataUrl(src);
      if (dataUrl) {
        // Approximate data URL size: 4/3 of the base64 payload.
        totalBytes += Math.floor((dataUrl.length - 22) * 0.75);
        srcToDataUrl.set(src, dataUrl);
      }
    }));

    if (srcToDataUrl.size === 0) return html;

    let out = html;
    for (const { tag, src } of wanted) {
      const dataUrl = srcToDataUrl.get(src);
      if (!dataUrl) continue;
      const newTag = tag.replace(srcAttrRe, `src="${dataUrl}"`);
      out = out.split(tag).join(newTag);
    }
    return out;
  }

  /** Fetch an ADO attachment (rich-text image) with auth as a data URL. */
  private async fetchAttachmentAsDataUrl(url: string): Promise<string | null> {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { ...this.headers, Accept: 'application/octet-stream' },
      });
      if (!response.ok) return null;
      const contentType = response.headers.get('content-type') || '';
      const mime = contentType.split(';')[0].trim().toLowerCase();
      if (!mime.startsWith('image/')) return null;
      const buf = Buffer.from(await response.arrayBuffer());
      if (buf.length > AdoClient.MAX_IMAGE_BYTES) return null;
      return `data:${mime};base64,${buf.toString('base64')}`;
    } catch {
      return null;
    }
  }

  /**
   * Create a new work item (Task, Bug, etc.) in Azure DevOps.
   * Uses JSON Patch (application/json-patch+json) with optional parent link.
   */
  async createWorkItem(
    project: string,
    workItemType: string,
    fields: {
      title: string;
      description?: string;
      acceptanceCriteria?: string;
      tags?: string;
      assignedTo?: string;
    },
    parentWorkItemId?: number
  ): Promise<{ id: number; url: string }> {
    const body: Array<{ op: string; path: string; value: any }> = [
      { op: 'add', path: '/fields/System.Title', value: fields.title },
    ];
    // Convert markdown to HTML for rich text fields that ADO expects
    if (fields.description) body.push({ op: 'add', path: '/fields/System.Description', value: markdownToHtml(fields.description) });
    if (fields.acceptanceCriteria) body.push({ op: 'add', path: '/fields/Microsoft.VSTS.Common.AcceptanceCriteria', value: markdownToHtml(fields.acceptanceCriteria) });
    if (fields.tags) body.push({ op: 'add', path: '/fields/System.Tags', value: fields.tags });
    if (fields.assignedTo) body.push({ op: 'add', path: '/fields/System.AssignedTo', value: fields.assignedTo });

    // Add parent link if specified
    if (parentWorkItemId) {
      body.push({
        op: 'add',
        path: '/relations/-',
        value: {
          rel: 'System.LinkTypes.Hierarchy-Reverse',
          url: `${this.baseUrl}/${project}/_apis/wit/workItems/${parentWorkItemId}`,
        },
      });
    }

    const result = await this.post<any>(
      `/${project}/_apis/wit/workitems/$${encodeURIComponent(workItemType)}?api-version=${GA_VERSION}`,
      body,
      { 'Content-Type': 'application/json-patch+json' }
    );
    return { id: result.id, url: result._links?.html?.href ?? '' };
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

  /**
   * Create a pull request (Git REST API, api-version 7.1 GA).
   * repositoryId may be the repo NAME or GUID. Guarded: refuses when
   * source and target branches are the same.
   */
  async createPullRequest(
    project: string,
    repositoryId: string,
    sourceBranch: string,
    targetBranch: string,
    title: string,
    description?: string
  ): Promise<{ pullRequestId: number; url: string; mergeStatus?: string }> {
    if (sourceBranch === targetBranch) {
      throw new Error(`createPullRequest: source and target branches are the same ('${sourceBranch}')`);
    }
    const pr = await this.post<any>(
      `/${project}/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullrequests?api-version=${GA_VERSION}`,
      {
        sourceRefName: `refs/heads/${sourceBranch}`,
        targetRefName: `refs/heads/${targetBranch}`,
        title,
        description: description || '',
      }
    );
    return {
      pullRequestId: pr.pullRequestId,
      url: pr.url ?? '',
      // ADO evaluates the merge asynchronously; the creation response carries
      // the initial mergeStatus (queued/conflicts/succeeded/rejected). The
      // LLM should re-check via resolve_pr_conflicts when it reads 'conflicts'.
      mergeStatus: pr.mergeStatus ?? undefined,
    };
  }

  /**
   * List pull requests whose SOURCE branch matches the given branch
   * (Git REST `searchCriteria.sourceRefName`). Used by post-merge cleanup:
   * a PR with status 'completed' + mergeStatus 'succeeded' means the branch
   * was merged and the worktree can be removed.
   */
  async getPullRequestsBySourceBranch(
    project: string,
    repositoryId: string,
    sourceBranch: string
  ): Promise<Array<{ pullRequestId: number; status: string; mergeStatus: string; url?: string }>> {
    const ref = `refs/heads/${sourceBranch}`;
    const result = await this.get<{ value: Array<{ pullRequestId: number; status: string; mergeStatus: string; url?: string }> }>(
      `/${project}/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullrequests?searchCriteria.sourceRefName=${encodeURIComponent(ref)}&api-version=${GA_VERSION}`
    );
    return result.value ?? [];
  }

  /**
   * Fetch a single pull request's merge status (Git REST). Task 4 (conflict
   * surfacing) reads mergeStatus/mergeFailureMessage from here.
   */
  async getPullRequest(
    project: string,
    repositoryId: string,
    pullRequestId: number
  ): Promise<{ pullRequestId: number; status: string; mergeStatus: string; mergeFailureMessage?: string; isDraft?: boolean; url?: string }> {
    return this.get<{ pullRequestId: number; status: string; mergeStatus: string; mergeFailureMessage?: string; isDraft?: boolean; url?: string }>(
      `/${project}/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullrequests/${pullRequestId}?api-version=${GA_VERSION}`
    );
  }

  private async get<T>(endpoint: string): Promise<T> {
    const url = this.buildUrl(endpoint);
    const response = await this.fetchWithFallback(url, { method: 'GET', headers: this.headers });
    return response.json() as Promise<T>;
  }

  private async post<T>(endpoint: string, body: any, headers?: Record<string, string>): Promise<T> {
    const url = this.buildUrl(endpoint);
    const response = await this.fetchWithFallback(url, {
      method: 'POST',
      headers: { ...this.headers, ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
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
