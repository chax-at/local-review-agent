// src/provider/bitbucket-cloud/cloud.types.ts

/** Cloud paged response. Pagination is via the absolute `next` URL. */
export interface ICloudPagedResponse<T> {
  values: T[];
  next?: string;
  pagelen?: number;
  page?: number;
  size?: number;
}

export interface ICloudUser {
  account_id?: string;
  nickname?: string;
  display_name?: string;
  uuid?: string;
}

export interface ICloudPullRequest {
  id: number;
  title: string;
  state: 'OPEN' | 'MERGED' | 'DECLINED' | 'SUPERSEDED';
  draft?: boolean;
  created_on: string;
  updated_on: string;
  source: {
    branch: { name: string };
    commit: { hash: string };
  };
  destination: {
    branch: { name: string };
    commit?: { hash: string };
  };
  author: ICloudUser;
}

export interface ICloudCommentInline {
  path: string;
  from?: number;
  to?: number;
}

export interface ICloudComment {
  id: number;
  content: { raw: string };
  user: ICloudUser;
  inline?: ICloudCommentInline;
  parent?: { id: number };
  deleted?: boolean;
  created_on: string;
  updated_on?: string;
}

export interface ICloudBuildStatus {
  key: string;
  state: 'SUCCESSFUL' | 'FAILED' | 'INPROGRESS' | 'STOPPED';
  name?: string;
  url: string;
  description?: string;
}

export interface ICloudRepository {
  slug: string;
  full_name: string;
  is_private?: boolean;
}

export interface ICloudBranch {
  name: string;
  target: { hash: string };
}

export interface ICloudCommit {
  hash: string;
  date: string;
}

export interface ICloudCreatePrPayload {
  title: string;
  description: string;
  source: { branch: { name: string } };
  destination: { branch: { name: string } };
  close_source_branch: boolean;
}
