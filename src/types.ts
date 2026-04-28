/** Raw block content as provided by the caller. All fields optional. */
export interface BlockInput {
  /** Markdown knowledge content. */
  knowledge?: string;
  /** XML rules string. Parsed into Rule[] for budgeting. */
  rules?: string;
  /** YAML examples string. Parsed into Example[] for budgeting. */
  examples?: string;
}

/** A parsed rule from rules XML. */
export interface Rule {
  readonly id: string;
  readonly content: string;
  readonly tokens: number;
  readonly priority?: number;
}

/** A parsed example from examples YAML. */
export interface Example {
  readonly id: string;
  readonly tags: readonly string[];
  readonly input: string;
  readonly output: string;
  readonly annotation?: string;
  readonly tokens: number;
  readonly priority?: number;
}

/** Options for compileContext(). */
export interface CompileContextOptions {
  /** Max token budget. Drops examples first, truncates knowledge, keeps rules. */
  budget?: number;
  /** Filter examples by tags. Only examples matching at least one tag are included. */
  tags?: string[];
}

/** Anthropic TextBlockParam with optional cache_control. */
export interface TextBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

/** Result of compileContext(). */
export interface CompiledContext {
  /** Formatted system prompt as a single string (for simple usage). */
  system: string;
  /** System prompt as TextBlockParam array with cache_control markers (for Anthropic API). */
  blocks: TextBlock[];
  /** Metadata about what was included/dropped during budgeting. */
  meta: {
    knowledgeTokens: number;
    rulesTokens: number;
    examplesTokens: number;
    totalTokens: number;
    budgetLimit: number | null;
    examplesDropped: number;
    knowledgeTruncated: boolean;
  };
}
