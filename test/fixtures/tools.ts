export interface ToolResult {
  readonly content: readonly { readonly type: string; readonly text: string }[];
  readonly isError?: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
}

export function firstText(result: ToolResult): string {
  const content = result.content[0];
  if (content === undefined) {
    throw new Error("Expected tool result text content");
  }
  return content.text;
}

export function toolDetails(result: ToolResult): Readonly<Record<string, unknown>> {
  if (result.details === undefined) {
    throw new Error("Expected tool result details");
  }
  return result.details;
}

export interface ToolOptions {
  readonly description: string;
  readonly promptSnippet?: string;
  readonly promptGuidelines?: readonly string[];
  readonly parameters: {
    readonly properties: Readonly<Record<string, unknown>>;
    readonly required?: readonly string[];
  };
  readonly execute: (
    callId: string,
    params: object,
    signal?: AbortSignal,
    onUpdate?: unknown,
    context?: {
      readonly hasUI: boolean;
      readonly ui?: {
        readonly confirm?: (title: string, message: string) => Promise<boolean>;
      };
    },
  ) => Promise<ToolResult>;
}
