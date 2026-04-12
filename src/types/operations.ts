export type CreateNodeOp = {
  op: 'create';
  type: string;
  name: string;
  properties?: Record<string, unknown>;
  summary?: string;
  confidence?: number;
};

export type UpdateNodeOp = {
  op: 'update';
  node_id: string;
  set?: Record<string, unknown>;
  unset?: string[];
  name?: string;
  summary?: string;
  confidence?: number;
};

export type DeleteNodeOp = {
  op: 'delete';
  node_id: string;
};

export type MutationOp = CreateNodeOp | UpdateNodeOp | DeleteNodeOp;

export type CreateLinkOp = {
  op: 'create';
  source_id: string;
  predicate: string;
  target_id: string;
  properties?: Record<string, unknown>;
  confidence?: number;
};

export type UpdateLinkOp = {
  op: 'update';
  edge_id?: string;
  source_id?: string;
  predicate?: string;
  target_id?: string;
  set?: Record<string, unknown>;
  confidence?: number;
};

export type DeleteLinkOp = {
  op: 'delete';
  edge_id?: string;
  source_id?: string;
  predicate?: string;
  target_id?: string;
};

export type LinkOp = CreateLinkOp | UpdateLinkOp | DeleteLinkOp;

export interface QueryParams {
  node_id?: string;
  node_name?: string;
  node_type?: string;
  traverse?: {
    from: string;
    predicates?: string[];
    direction: 'outgoing' | 'incoming' | 'both';
    depth: number;
  };
  include_archived?: boolean;
  limit?: number;
}

export interface MutationResult {
  op: string;
  node_id: string;
  version: number;
}

export interface LinkResult {
  op: string;
  edge_id: string;
}
