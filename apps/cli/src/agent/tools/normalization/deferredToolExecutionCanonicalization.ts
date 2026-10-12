import type { ToolNormalizationProtocol } from '@happier-dev/protocol';

type UnknownRecord = Record<string, unknown>;

// CodeBuddy Code 2.162 loads MCP tools lazily: `ToolSearch` resolves them and the call itself is an
// ACP `other` tool titled `DeferExecuteTool` with input `{ toolName, params }`.
const GENERIC_WRAPPER_TOOL_NAMES = new Set(['other', 'unknown', 'unknown tool', 'deferexecutetool']);

function asRecord(value: unknown): UnknownRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as UnknownRecord;
}

export function extractDeferredToolExecutionCall(opts: {
    protocol: ToolNormalizationProtocol;
    toolName: string;
    rawInput: unknown;
}): { toolName: string; params: UnknownRecord } | null {
    if (opts.protocol !== 'acp' || !GENERIC_WRAPPER_TOOL_NAMES.has(opts.toolName.trim().toLowerCase())) return null;
    const record = asRecord(opts.rawInput);
    const acp = asRecord(record?._acp);
    // Wrapper identity comes from the transport envelope, never user-owned tool arguments.
    if (!record || acp?.kind !== 'other' || typeof acp.title !== 'string'
        || acp.title.trim().toLowerCase() !== 'deferexecutetool') return null;
    const toolName = typeof record.toolName === 'string' ? record.toolName.trim() : '';
    if (!toolName) return null;
    return { toolName, params: asRecord(record.params) ?? {} };
}
