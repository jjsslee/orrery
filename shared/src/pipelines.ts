export interface PipelineExecutionSummary { id: string; status: string; startedAt?: string; updatedAt?: string; }
export interface PipelineAction { id?: string; stage: string; name: string; status: string; startedAt?: string; updatedAt?: string; error?: string; }
export interface PipelinePage { names: string[]; nextToken?: string; }
export interface PipelineHistory { executions: PipelineExecutionSummary[]; nextToken?: string; }
export interface PipelineDetail { status: string; stages: string[]; actions: PipelineAction[]; checkedAt: string; }
