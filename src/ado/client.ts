import { AdoWorkItem, AdoWorkItemReference, WiqlResult, AdoComment } from './types';

export class AdoClient {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(organization: string, pat: string, serverUrl?: string) {
    if (!organization || !pat) {
      throw new Error('AdoClient requires organization and PAT');
    }
    // Q2 resolution: serverUrl (on-prem ADO Server) wins when provided;
    // otherwise build the cloud URL from the org name.
    this.baseUrl = serverUrl && serverUrl.trim()
      ? serverUrl.replace(/\/+$/, '')
      : `https://dev.azure.com/${organization}`;
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
    // Step 1: WIQL query to find assigned work items
    const wiqlQuery = {
      query: `SELECT [System.Id], [System.Title], [System.State], [System.WorkItemType], [System.AssignedTo] FROM WorkItems WHERE [System.AssignedTo] = @me AND [System.State] <> 'Closed' AND [System.State] <> 'Done' ORDER BY [System.ChangedDate] DESC`
    };

    const wiqlResponse = await this.post<WiqlResult>(
      `/${project}/_apis/wit/wiql?api-version=7.1-preview.2`,
      wiqlQuery
    );

    if (!wiqlResponse.workItems || wiqlResponse.workItems.length === 0) {
      return [];
    }

    // Step 2: Fetch full details for each work item
    const ids = wiqlResponse.workItems.map(wi => wi.id).join(',');
    const batchResponse = await this.get<{ value: AdoWorkItem[] }>(
      `/_apis/wit/workitems?ids=${ids}&fields=System.Id,System.Title,System.State,System.AssignedTo,System.WorkItemType&api-version=7.1-preview.3`
    );

    return batchResponse.value || [];
  }

  async getWorkItemDetail(
    project: string,
    workItemId: number
  ): Promise<AdoWorkItem> {
    return this.get<AdoWorkItem>(
      `/_apis/wit/workitems/${workItemId}?api-version=7.1-preview.3`
    );
  }

  async addComment(
    project: string,
    workItemId: number,
    text: string
  ): Promise<AdoComment> {
    return this.post<AdoComment>(
      `/${project}/_apis/wit/workItems/${workItemId}/comments?api-version=7.1-preview.4`,
      { text }
    );
  }

  async getComments(
    project: string,
    workItemId: number
  ): Promise<AdoComment[]> {
    const response = await this.get<{ value: AdoComment[] }>(
      `/${project}/_apis/wit/workItems/${workItemId}/comments?api-version=7.1-preview.4`
    );
    return response.value || [];
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
    const response = await fetch(
      `${this.baseUrl}/${project}/_apis/wit/workitems/${workItemId}?api-version=7.1-preview.3`,
      {
        method: 'PATCH',
        headers: { ...this.headers, 'Content-Type': 'application/json-patch+json' },
        body: JSON.stringify(fields),
      }
    );

    if (!response.ok) {
      throw new Error(`ADO API error: ${response.status} ${await response.text()}`);
    }

    return response.json();
  }

  private async get<T>(endpoint: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method: 'GET',
      headers: this.headers,
    });

    if (!response.ok) {
      throw new Error(`ADO API error: ${response.status} ${await response.text()}`);
    }

    return response.json() as Promise<T>;
  }

  private async post<T>(endpoint: string, body: any): Promise<T> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`ADO API error: ${response.status} ${await response.text()}`);
    }

    return response.json() as Promise<T>;
  }
}
