export interface IBitbucketRef {
  id: string;
  displayId: string;
  latestCommit: string;
  repository: {
    slug: string;
    project: { key: string };
  };
}

export interface IBitbucketPullRequest {
  id: number;
  title: string;
  state: string;
  open: boolean;
  draft?: boolean;
  /** Milliseconds since epoch (Bitbucket Server REST). */
  createdDate?: number;
  /** Milliseconds since epoch (Bitbucket Server REST). */
  updatedDate?: number;
  /** Optimistic-lock version used by Bitbucket Server PUT updates. */
  version?: number;
  fromRef: IBitbucketRef;
  toRef: IBitbucketRef;
  author: {
    user: { slug: string };
  };
}

export interface IBitbucketPagedResponse<T> {
  size: number;
  limit: number;
  isLastPage: boolean;
  start: number;
  nextPageStart?: number;
  values: T[];
}

export interface IBitbucketActivity {
  id: number;
  action: string;
  comment?: {
    id: number;
    text: string;
    author: { slug: string };
    anchor?: {
      line: number;
      lineType: string;
      path: string;
    };
    /** Nested thread replies (Bitbucket Server embeds replies inside the parent comment) */
    comments?: Array<{
      id: number;
      text: string;
      author: { slug: string };
    }>;
  };
}

export interface IBitbucketComment {
  id: number;
  text: string;
  author: { slug: string };
  anchor?: {
    line: number;
    lineType: string;
    path: string;
    srcPath?: string;
  };
}

export interface IBitbucketInlineCommentPayload {
  text: string;
  anchor: {
    line: number;
    lineType: string;
    path: string;
    srcPath?: string;
    multilineMarker?: { startLine: number; startLineType: 'ADDED' | 'REMOVED' | 'CONTEXT' };
    multilineSpan?: { dstSpanStart: number; dstSpanEnd: number };
  };
}

export interface IBitbucketProject {
  key: string;
  name: string;
}

export interface IBitbucketRepo {
  slug: string;
  project: { key: string };
}

export interface IBitbucketBuildStatus {
  state: 'SUCCESSFUL' | 'FAILED' | 'INPROGRESS';
  key: string;
  url: string;
  description?: string;
  name?: string;
  dateAdded?: number;
}

export interface IBitbucketCreatePrPayload {
  title: string;
  description: string;
  fromRef: { id: string; repository: { slug: string; project: { key: string } } };
  toRef: { id: string; repository: { slug: string; project: { key: string } } };
}
