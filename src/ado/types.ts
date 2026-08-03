export interface AdoWorkItemTypeState {
  name: string;
  color?: string;
  category?: string;
}

export interface AdoTeamMember {
  displayName: string;
  uniqueName: string;
}

export interface AdoProject {
  id: string;
  name: string;
  state: string;
  url: string;
  description?: string;
  revision?: number;
  visibility?: string;
  lastUpdateTime?: string;
}

export interface AdoWorkItem {
  id: number;
  fields: {
    'System.Title': string;
    'System.State': string;
    'System.AssignedTo': { displayName: string; uniqueName: string };
    'System.WorkItemType': string;
    'System.Description'?: string;
    'Microsoft.VSTS.Common.AcceptanceCriteria'?: string;
    'System.Tags'?: string;
    'System.AreaPath': string;
    'System.IterationPath': string;
    // C-5 fix: declared HERE (Task 7) — getWorkItemWithDiscussion in this task
    // reads System.CreatedBy; Task 28's clarification flow needs it too.
    'System.CreatedBy'?: { displayName: string; uniqueName: string };
    'System.CreatedDate'?: string;
    'System.ChangedDate'?: string;
    // Bug-specific fields
    'Microsoft.VSTS.TCM.ReproSteps'?: string;
    'Microsoft.VSTS.TCM.SystemInfo'?: string;
  };
  _links: {
    self: { href: string };
    html: { href: string };
  };
}

export interface AdoWorkItemReference {
  id: number;
  url: string;
}

export interface WiqlResult {
  workItems: AdoWorkItemReference[];
}

export interface AdoComment {
  id: number;
  text: string;
  createdBy: { displayName: string };
  createdDate: string;
}
