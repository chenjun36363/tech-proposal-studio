export type LongWritingMode = "modify" | "create";

export type LongWritingTaskStatus =
  | "preparing"
  | "awaiting_outline"
  | "running"
  | "paused"
  | "checking"
  | "awaiting_repairs"
  | "completed"
  | "cancelled"
  | "restored"
  | "failed"
  | "conflict";

export type ChapterJobStatus =
  | "queued"
  | "analyzing"
  | "awaiting_write"
  | "writing"
  | "running"
  | "validating"
  | "committing"
  | "completed"
  | "awaiting_review"
  | "retryable"
  | "failed"
  | "cancelled";

export type ConsistencyIssueType =
  | "terminology"
  | "fact"
  | "duplication"
  | "missing_chapter"
  | "transition"
  | "markdown";

export type ConsistencyIssueSeverity = "low" | "medium" | "high";
export type ConsistencyIssueStatus = "pending" | "selected" | "dismissed" | "repaired";

export type LongWritingEventType =
  | "server_started"
  | "server_stopped"
  | "session_created"
  | "analysis_completed"
  | "task_started"
  | "backup_created"
  | "summary_started"
  | "summary_completed"
  | "summary_fallback"
  | "outline_started"
  | "outline_fallback"
  | "outline_completed"
  | "outline_confirmed"
  | "model_changed"
  | "worker_started"
  | "worker_retry"
  | "draft_received"
  | "validation_passed"
  | "commit_started"
  | "commit_completed"
  | "consistency_started"
  | "consistency_completed"
  | "conflict_detected"
  | "scope_review_requested"
  | "scope_review_accepted"
  | "scope_review_rejected"
  | "paused"
  | "resumed"
  | "failed"
  | "cancelled"
  | "restored";

export type LongWritingEventDetails = Record<string, string | number | boolean | null>;

export interface LongWritingEvent {
  id: string;
  type: LongWritingEventType;
  message: string;
  at: string;
  chapterId?: string;
  attempt?: number;
  details?: LongWritingEventDetails;
}

export interface TerminologyEntry {
  term: string;
  definition: string;
}

export interface LongWritingSourceRef {
  id: string;
  title: string;
  path?: string;
  excerpt?: string;
  content?: string;
  contentHash?: string;
}

/** Generic frozen tree used by outline review UIs that need nested headings. */
export interface FrozenOutlineHeading {
  id: string;
  level: number;
  title: string;
  parentId?: string;
  order: number;
  children: FrozenOutlineHeading[];
}

export type OutlineChapterAction = "fill" | "rewrite" | "modify" | "keep";

export interface OutlineChapterPlan {
  chapterId: string;
  order: number;
  titlePath: string[];
  headingSkeleton: string[];
  goal: string;
  action: OutlineChapterAction;
}

export interface ChapterTransitionRequirement {
  fromChapterId: string;
  toChapterId: string;
  requirement: string;
}

export interface OutlinePlan {
  documentSummary: string;
  audience: string;
  writingRules: string[];
  fixedFacts: string[];
  terminology: TerminologyEntry[];
  frozenOutline: OutlineChapterPlan[];
  transitionRequirements: ChapterTransitionRequirement[];
  targetChapterIds: string[];
  /** Added after the user confirms the generated outline. */
  frozenHeadingSignature?: string;
}

/** Exact structured payload returned by submit_chapter_draft. */
export interface ChapterDraftResult {
  chapterId: string;
  markdown: string;
  summary: string;
  factsUsed: string[];
  terminologyUsed: TerminologyEntry[];
  openQuestions: string[];
}

export type ChapterDraftSubmission = ChapterDraftResult;

export interface OutlinePlanSubmission {
  plan: OutlinePlan;
  rationale: string;
  warnings: string[];
}

export interface ConsistencyIssue {
  id: string;
  type: ConsistencyIssueType;
  chapterIds: string[];
  evidence: string;
  severity: ConsistencyIssueSeverity;
  suggestion: string;
  status: ConsistencyIssueStatus;
}

export interface ConsistencyReportSubmission {
  issues: ConsistencyIssue[];
}

export interface LongWritingScopeReview {
  reason: string;
  proposedDocumentMarkdown: string;
  proposedDocumentHash: string;
  rollbackDocumentHash: string;
  createdAt: string;
  decision?: "accepted" | "rejected";
  decidedAt?: string;
}

export interface ChapterJob {
  id: string;
  headingId?: string;
  headingLevel?: number;
  parentHeadingId?: string;
  sessionId?: string;
  analysis?: string;
  preEditDocumentMarkdown?: string;
  preEditDocumentHash?: string;
  postEditDocumentHash?: string;
  taskId: string;
  chapterId: string;
  scopeReview?: LongWritingScopeReview;
  order: number;
  titlePath: string[];
  status: ChapterJobStatus;
  originalMarkdown: string;
  originalHash: string;
  frozenHeadingSignature: string;
  attempts: number;
  maxAttempts: number;
  draft?: ChapterDraftResult;
  committedChapterHash?: string;
  commitTargetDocumentHash?: string;
  summary?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface LongWritingBackupRecord {
  path: string;
  sourceFilePath: string;
  sourceHash: string;
  kind: "initial" | "pre_restore" | "pre_repair";
  createdAt: string;
}

export interface LongWritingTaskRecord {
  id: string;
  schemaVersion?: 2;
  backend?: "opencode-http";
  mainSessionId?: string;
  serverVersion?: string;
  selectedHeadingIds?: string[];
  modelRef?: { providerId: string; modelId: string };
  mainAnalysis?: string;
  generatedOutlineMarkdown?: string;
  filePath: string;
  workspaceRoot: string;
  mode: LongWritingMode;
  status: LongWritingTaskStatus;
  instruction: string;
  /** Required for create tasks; absent in persisted tasks created before this mode existed. */
  documentTitle?: string;
  model: string;
  modelProviderId?: string;
  /** 任务级备用模型链（覆盖项目默认），主模型不可用时按序切换。 */
  fallbackModels?: { providerId: string; model: string }[];
  concurrency: 1 | 2 | 3;
  selectedChapterIds: string[];
  sourceRefs: LongWritingSourceRef[];
  initialDocumentHash: string;
  currentDocumentHash: string;
  initialBackup: LongWritingBackupRecord;
  plan?: OutlinePlan;
  chapters: ChapterJob[];
  consistencyIssues: ConsistencyIssue[];
  /** Bounded, secret-sanitized long-task event history persisted with the task payload. */
  events?: LongWritingEvent[];
  error?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface ChapterSummarySubmission {
  chapterId: string;
  titlePath: string[];
  summary: string;
  facts: string[];
  terminology: TerminologyEntry[];
  unresolvedQuestions: string[];
}

export interface ChapterRepairSubmission extends ChapterDraftResult {
  issueIds: string[];
}

export type LongWritingStructuredModelResult =
  | { type: "outline_plan"; value: OutlinePlan }
  | { type: "chapter_summary"; value: ChapterSummarySubmission }
  | { type: "chapter_draft"; value: ChapterDraftResult }
  | { type: "consistency_report"; value: ConsistencyReportSubmission }
  | { type: "chapter_repair"; value: ChapterRepairSubmission };
