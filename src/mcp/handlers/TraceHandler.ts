/**
 * @fileoverview Trace MCP Handler for sera-core
 * @module sera-core/mcp/handlers/TraceHandler
 *
 * Implements 5 graph traversal tools for the cartography graph:
 * - trace_calls_to: Reverse BFS from target to entry points
 * - trace_calls_from: Forward DFS from source to all reachable functions
 * - trace_interacting_functions: Immediate callers/callees + state overlap
 * - trace_read_slot: Functions that read a state variable
 * - trace_write_slot: Functions that write to a state variable
 *
 * Ported from the VS Code extension's tracecp applet. Uses ctx.db.sql()
 * for all database queries instead of CartographyStorageIntegration.
 *
 * The cartography tables (cartography_nodes, cartography_edges) are created
 * by the extension's CartographyApplet via WebSocket - this handler only
 * reads from them.
 *
 * Performance: On first trace call per repo, preloads all call edges into
 * adjacency lists (forward + reverse maps). Cached with 60s TTL.
 */

import {
    PortableMcpHandler,
    McpToolDefinition,
    HandlerContext,
} from '@sera/types';
import { createLogger } from '../../logging/Logger';

const log = createLogger('trace-handler');

// ============================================================================
// CONSTANTS
// ============================================================================

const MAX_DEPTH_CAP = 20;
const DEFAULT_MAX_DEPTH = 10;
const DEFAULT_MAX_PATHS = 50;
const CACHE_TTL_MS = 60_000;

// ============================================================================
// TYPES
// ============================================================================

interface TraceFunctionRef {
    function_id: string;
    contract: string;
    function_name: string;
    file: string;
    line: number;
    end_line: number;
}

interface TraceCallsToInput {
    repo_id: string;
    function_id: string;
    max_depth?: number;
    max_paths?: number;
}

interface TraceCallsToOutput {
    target: TraceFunctionRef;
    paths: TraceFunctionRef[][];
    total_paths_found: number;
    truncated: boolean;
}

interface TraceCallsFromInput {
    repo_id: string;
    function_id: string;
    max_depth?: number;
}

interface TraceTreeNode {
    function: TraceFunctionRef;
    depth: number;
    children: TraceTreeNode[];
}

interface TraceCallsFromOutput {
    source: TraceFunctionRef;
    reachable: TraceFunctionRef[];
    tree: TraceTreeNode;
    total_reachable: number;
}

interface TraceInteractingInput {
    repo_id: string;
    function_id: string;
    include_state_access?: boolean;
}

interface StateOverlap {
    state_var: string;
    state_var_id: string;
    functions: TraceFunctionRef[];
}

interface TraceInteractingOutput {
    function: TraceFunctionRef;
    callers: TraceFunctionRef[];
    callees: TraceFunctionRef[];
    reads?: string[];
    writes?: string[];
    state_overlaps?: StateOverlap[];
}

interface TraceSlotInput {
    repo_id: string;
    state_var_name: string;
}

interface TraceSlotOutput {
    state_var_name: string;
    matching_vars: string[];
    functions: TraceFunctionRef[];
}

interface AdjacencyCache {
    forward: Map<string, string[]>;   // fromId -> toIds
    reverse: Map<string, string[]>;   // toId -> fromIds
    timestamp: number;
}

// ============================================================================
// SQL QUERY HELPERS
// ============================================================================

/**
 * Get all edges of a given type within a repo.
 * @param ctx - Handler context with database access
 * @param repoId - Repository ID
 * @param edgeType - Edge type (e.g., 'CALLS_INTERNAL', 'CALLS_EXTERNAL')
 * @returns Array of edge rows
 */
async function getEdgesByRepo(ctx: HandlerContext, repoId: string, edgeType: string): Promise<any[]> {
    return ctx.db.sql(
        'SELECT * FROM cartography_edges WHERE repoId = ? AND edgeType = ?',
        [repoId, edgeType]
    );
}

/**
 * Get all edges originating from a node with a given type.
 * @param ctx - Handler context with database access
 * @param nodeId - Source node ID
 * @param edgeType - Edge type filter
 * @returns Array of edge rows
 */
async function getEdgesFrom(ctx: HandlerContext, nodeId: string, edgeType: string): Promise<any[]> {
    return ctx.db.sql(
        'SELECT * FROM cartography_edges WHERE fromNodeId = ? AND edgeType = ?',
        [nodeId, edgeType]
    );
}

/**
 * Get all edges targeting a node with a given type.
 * @param ctx - Handler context with database access
 * @param nodeId - Target node ID
 * @param edgeType - Edge type filter
 * @returns Array of edge rows
 */
async function getEdgesTo(ctx: HandlerContext, nodeId: string, edgeType: string): Promise<any[]> {
    return ctx.db.sql(
        'SELECT * FROM cartography_edges WHERE toNodeId = ? AND edgeType = ?',
        [nodeId, edgeType]
    );
}

/**
 * Get a single node by ID.
 * @param ctx - Handler context with database access
 * @param nodeId - Node ID to look up
 * @returns Node row or null if not found
 */
async function getNode(ctx: HandlerContext, nodeId: string): Promise<any | null> {
    const rows = await ctx.db.sql(
        'SELECT * FROM cartography_nodes WHERE nodeId = ?',
        [nodeId]
    );
    return rows.length > 0 ? rows[0] : null;
}

/**
 * Get all nodes of a given type within a repo.
 * @param ctx - Handler context with database access
 * @param repoId - Repository ID
 * @param nodeType - Node type filter (e.g., 'statevar', 'function')
 * @returns Array of node rows
 */
async function getNodesByRepo(ctx: HandlerContext, repoId: string, nodeType: string): Promise<any[]> {
    return ctx.db.sql(
        'SELECT * FROM cartography_nodes WHERE repoId = ? AND nodeType = ?',
        [repoId, nodeType]
    );
}

// ============================================================================
// OUTPUT FORMATTERS
// ============================================================================

/**
 * Convert 0-based AST line to 1-based editor line.
 * All internal line numbers are 0-based (from byteOffsetToLine),
 * but LLMs, editors, Read tool, sed, cat -n all use 1-based.
 * @param n - 0-based line number
 * @returns 1-based line number
 */
function line1(n: number): number {
    return n + 1;
}

/**
 * Format a function ref as `Contract.name (L<start>:L<end>)`.
 * @param ref - Function reference to format
 * @returns Formatted string
 */
function fmtFunc(ref: TraceFunctionRef): string {
    const start = line1(ref.line);
    const end = line1(ref.end_line);
    const lines = end > start ? `L${start}:L${end}` : `L${start}`;
    return `${ref.contract}.${ref.function_name} (${lines})`;
}

/**
 * Format a function ref for use in arrow chains. Omits contract
 * if same as context contract for compactness.
 * @param ref - Function reference to format
 * @param contextContract - If ref is in this contract, omit the contract prefix
 * @returns Formatted string
 */
function fmtStep(ref: TraceFunctionRef, contextContract?: string): string {
    const start = line1(ref.line);
    const end = line1(ref.end_line);
    const lines = end > start ? `L${start}:L${end}` : `L${start}`;
    if (contextContract && ref.contract === contextContract) {
        return `${ref.function_name}(${lines})`;
    }
    return `${ref.contract}.${ref.function_name}(${lines})`;
}

/**
 * Detect if all refs in a path share the same contract.
 * @param refs - Array of function references
 * @returns True if all refs share the same contract
 */
function isSameContract(refs: TraceFunctionRef[]): boolean {
    if (refs.length === 0) return true;
    const first = refs[0].contract;
    return refs.every(r => r.contract === first);
}

/**
 * Format trace_calls_to output as compact markdown.
 * Shows paths as arrow chains with line numbers.
 * @param output - Structured trace result
 * @returns Markdown string
 */
function formatCallsTo(output: TraceCallsToOutput): string {
    const lines: string[] = [];

    lines.push(`## trace_calls_to: ${output.target.function_name}`);
    lines.push('');
    lines.push(`**Target:** ${fmtFunc(output.target)}`);
    lines.push(`**File:** ${output.target.file}`);
    lines.push('');

    if (output.paths.length === 0) {
        lines.push('No paths found (function has no callers - may be an entry point).');
        return lines.join('\n');
    }

    lines.push(`### Paths (${output.total_paths_found}${output.truncated ? ', truncated' : ''})`);

    for (const path of output.paths) {
        const sameContract = isSameContract(path);
        const contextContract = sameContract ? path[0].contract : undefined;

        const steps = path.map(ref => fmtStep(ref, contextContract));
        const prefix = sameContract ? `[${path[0].contract}] ` : '';
        lines.push(`- ${prefix}${steps.join(' -> ')}`);
    }

    return lines.join('\n');
}

/**
 * Recursively format a tree node with indentation.
 * @param node - Tree node to format
 * @param lines - Output lines array (mutated)
 * @param depth - Current depth for indentation
 * @param sourceContract - Source contract for external detection
 */
function formatTreeNode(
    node: TraceTreeNode,
    lines: string[],
    depth: number,
    sourceContract: string
): void {
    const indent = depth === 0 ? '' : '  '.repeat(depth) + '-> ';
    const isExternal = node.function.contract !== sourceContract;
    const label = fmtStep(node.function, sourceContract);
    const suffix = isExternal ? ' [external]' : '';

    lines.push(`${indent}${label}${suffix}`);

    for (const child of node.children) {
        formatTreeNode(child, lines, depth + 1, sourceContract);
    }
}

/**
 * Format trace_calls_from output as compact markdown with indented tree.
 * @param output - Structured trace result
 * @returns Markdown string
 */
function formatCallsFrom(output: TraceCallsFromOutput): string {
    const lines: string[] = [];

    lines.push(`## trace_calls_from: ${output.source.function_name}`);
    lines.push('');
    lines.push(`**Source:** ${fmtFunc(output.source)}`);
    lines.push(`**File:** ${output.source.file}`);
    lines.push(`**Reachable:** ${output.total_reachable} functions`);
    lines.push('');
    lines.push('### Call Tree');

    const sourceContract = output.source.contract;
    formatTreeNode(output.tree, lines, 0, sourceContract);

    return lines.join('\n');
}

/**
 * Format trace_interacting_functions output as compact markdown.
 * Shows callers, callees, state access, and overlaps sections.
 * @param output - Structured trace result
 * @returns Markdown string
 */
function formatInteracting(output: TraceInteractingOutput): string {
    const lines: string[] = [];
    const func = output.function;
    const sourceContract = func.contract;

    lines.push(`## trace_interacting: ${func.function_name}`);
    lines.push('');
    lines.push(`**Function:** ${fmtFunc(func)}`);
    lines.push(`**File:** ${func.file}`);
    lines.push('');

    // Callers
    lines.push('### Callers');
    if (output.callers.length === 0) {
        lines.push('(none)');
    } else {
        for (const c of output.callers) {
            const isExternal = c.contract !== sourceContract;
            const label = fmtStep(c, sourceContract);
            lines.push(`- ${label}${isExternal ? ' [external]' : ''}`);
        }
    }
    lines.push('');

    // Callees
    lines.push('### Callees');
    if (output.callees.length === 0) {
        lines.push('(none)');
    } else {
        for (const c of output.callees) {
            const isExternal = c.contract !== sourceContract;
            const label = fmtStep(c, sourceContract);
            lines.push(`- ${label}${isExternal ? ' [external]' : ''}`);
        }
    }

    // State access (only if included)
    if (output.reads !== undefined || output.writes !== undefined) {
        lines.push('');
        lines.push('### State Access');

        const readNames = (output.reads || []).map(id => id.split('_').pop() || id);
        const writeNames = (output.writes || []).map(id => id.split('_').pop() || id);

        lines.push(`**Reads:** ${readNames.length > 0 ? readNames.join(', ') : '(none)'}`);
        lines.push(`**Writes:** ${writeNames.length > 0 ? writeNames.join(', ') : '(none)'}`);
    }

    // State overlaps
    if (output.state_overlaps && output.state_overlaps.length > 0) {
        lines.push('');
        lines.push('### State Overlaps');
        for (const overlap of output.state_overlaps) {
            const funcNames = overlap.functions
                .map(f => fmtStep(f, sourceContract))
                .join(', ');
            lines.push(`- \`${overlap.state_var}\` - also accessed by ${funcNames}`);
        }
    }

    return lines.join('\n');
}

/**
 * Format trace_read_slot / trace_write_slot output as compact markdown.
 * @param output - Structured trace result
 * @param accessType - Whether this is a 'read' or 'write' query
 * @returns Markdown string
 */
function formatSlot(output: TraceSlotOutput, accessType: 'read' | 'write'): string {
    const lines: string[] = [];
    const toolName = accessType === 'read' ? 'trace_read_slot' : 'trace_write_slot';
    const verb = accessType === 'read' ? 'Read' : 'Written';

    lines.push(`## ${toolName}: ${output.state_var_name}`);
    lines.push('');
    lines.push(`**State var:** ${output.state_var_name}`);

    // Extract contract names from var node IDs (var_ContractName_varName)
    const contracts = output.matching_vars.map(id => {
        const parts = id.split('_');
        // var_ContractName_varName -> ContractName
        return parts.length >= 3 ? parts.slice(1, -1).join('_') : id;
    });
    lines.push(`**Declared in:** ${contracts.join(', ')}`);
    lines.push('');

    if (output.functions.length === 0) {
        lines.push(`No functions ${accessType === 'read' ? 'read' : 'write to'} this variable.`);
        return lines.join('\n');
    }

    lines.push(`### ${verb} by (${output.functions.length})`);
    for (const f of output.functions) {
        lines.push(`- ${fmtFunc(f)}`);
    }

    return lines.join('\n');
}

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

const TRACE_TOOLS: McpToolDefinition[] = [
    {
        name: 'trace_calls_to',
        description: 'Find all code paths from entry points to a target function (reverse trace). Performs reverse BFS following incoming CALLS_INTERNAL and CALLS_EXTERNAL edges to reconstruct all call chains that reach the target. Entry points are functions with no incoming call edges.',
        inputSchema: {
            type: 'object',
            properties: {
                repo_id: { description: 'Repository ID from cartography', type: 'string' },
                function_id: { description: 'Target function node ID (e.g., "func_RocketMegapoolDelegate_stake")', type: 'string' },
                max_depth: { description: 'Maximum traversal depth (default: 10, max: 20)', type: 'number' },
                max_paths: { description: 'Maximum number of paths to return (default: 50)', type: 'number' },
            },
            required: ['repo_id', 'function_id'],
        },
    },
    {
        name: 'trace_calls_from',
        description: 'Find all functions reachable from a starting function (forward trace). Performs forward DFS following outgoing CALLS_INTERNAL and CALLS_EXTERNAL edges. Returns a tree structure with depth levels and a flat list of all reachable functions.',
        inputSchema: {
            type: 'object',
            properties: {
                repo_id: { description: 'Repository ID from cartography', type: 'string' },
                function_id: { description: 'Source function node ID to trace from', type: 'string' },
                max_depth: { description: 'Maximum traversal depth (default: 10, max: 20)', type: 'number' },
            },
            required: ['repo_id', 'function_id'],
        },
    },
    {
        name: 'trace_interacting_functions',
        description: 'Get immediate callers and callees of a function with optional state variable overlap analysis. When include_state_access is true, also queries READS/WRITES edges and cross-references callers/callees to find functions that share state variables with the target.',
        inputSchema: {
            type: 'object',
            properties: {
                repo_id: { description: 'Repository ID from cartography', type: 'string' },
                function_id: { description: 'Function node ID to analyze', type: 'string' },
                include_state_access: { description: 'Include state variable read/write analysis and overlap detection (default: false)', type: 'boolean' },
            },
            required: ['repo_id', 'function_id'],
        },
    },
    {
        name: 'trace_read_slot',
        description: 'Find all functions that read a specific state variable. Searches for READS edges where the target node matches the state variable name pattern. Returns all matching variable node IDs and the functions that read them across all contracts.',
        inputSchema: {
            type: 'object',
            properties: {
                repo_id: { description: 'Repository ID from cartography', type: 'string' },
                state_var_name: { description: 'State variable name to search for (e.g., "totalSupply", "balances")', type: 'string' },
            },
            required: ['repo_id', 'state_var_name'],
        },
    },
    {
        name: 'trace_write_slot',
        description: 'Find all functions that write to a specific state variable. Searches for WRITES edges where the target node matches the state variable name pattern. Returns all matching variable node IDs and the functions that write them across all contracts.',
        inputSchema: {
            type: 'object',
            properties: {
                repo_id: { description: 'Repository ID from cartography', type: 'string' },
                state_var_name: { description: 'State variable name to search for (e.g., "totalSupply", "balances")', type: 'string' },
            },
            required: ['repo_id', 'state_var_name'],
        },
    },
];

// ============================================================================
// HANDLER
// ============================================================================

export class TraceHandler implements PortableMcpHandler {
    /** Adjacency list cache keyed by repoId. 60s TTL. */
    private adjacencyCache: Map<string, AdjacencyCache> = new Map();
    /** Resolved function ref cache keyed by nodeId. Avoids repeated DB lookups. */
    private funcRefCache: Map<string, TraceFunctionRef | null> = new Map();

    getToolDefinitions(): McpToolDefinition[] {
        return TRACE_TOOLS;
    }

    async handleToolCall(
        toolName: string,
        args: Record<string, unknown>,
        ctx: HandlerContext
    ): Promise<unknown> {
        switch (toolName) {
            case 'trace_calls_to':
                return this.handleTraceCallsTo(args, ctx);
            case 'trace_calls_from':
                return this.handleTraceCallsFrom(args, ctx);
            case 'trace_interacting_functions':
                return this.handleTraceInteracting(args, ctx);
            case 'trace_read_slot':
                return this.handleTraceReadSlot(args, ctx);
            case 'trace_write_slot':
                return this.handleTraceWriteSlot(args, ctx);
            default:
                throw new Error(`Unknown trace tool: ${toolName}`);
        }
    }

    // ========================================================================
    // TOOL HANDLERS
    // ========================================================================

    private async handleTraceCallsTo(
        args: Record<string, unknown>,
        ctx: HandlerContext
    ): Promise<string> {
        const input: TraceCallsToInput = {
            repo_id: args.repo_id as string,
            function_id: args.function_id as string,
            max_depth: args.max_depth as number | undefined,
            max_paths: args.max_paths as number | undefined,
        };

        const result = await this.traceCallsTo(input, ctx);
        return formatCallsTo(result);
    }

    private async handleTraceCallsFrom(
        args: Record<string, unknown>,
        ctx: HandlerContext
    ): Promise<string> {
        const input: TraceCallsFromInput = {
            repo_id: args.repo_id as string,
            function_id: args.function_id as string,
            max_depth: args.max_depth as number | undefined,
        };

        const result = await this.traceCallsFrom(input, ctx);
        return formatCallsFrom(result);
    }

    private async handleTraceInteracting(
        args: Record<string, unknown>,
        ctx: HandlerContext
    ): Promise<string> {
        const input: TraceInteractingInput = {
            repo_id: args.repo_id as string,
            function_id: args.function_id as string,
            include_state_access: args.include_state_access as boolean | undefined,
        };

        const result = await this.traceInteracting(input, ctx);
        return formatInteracting(result);
    }

    private async handleTraceReadSlot(
        args: Record<string, unknown>,
        ctx: HandlerContext
    ): Promise<string> {
        const input: TraceSlotInput = {
            repo_id: args.repo_id as string,
            state_var_name: args.state_var_name as string,
        };

        const result = await this.traceSlot(input, 'READS', ctx);
        return formatSlot(result, 'read');
    }

    private async handleTraceWriteSlot(
        args: Record<string, unknown>,
        ctx: HandlerContext
    ): Promise<string> {
        const input: TraceSlotInput = {
            repo_id: args.repo_id as string,
            state_var_name: args.state_var_name as string,
        };

        const result = await this.traceSlot(input, 'WRITES', ctx);
        return formatSlot(result, 'write');
    }

    // ========================================================================
    // ADJACENCY LIST CACHE
    // ========================================================================

    /**
     * Get or build adjacency lists for a repo's call edges.
     * Loads CALLS_INTERNAL + CALLS_EXTERNAL into forward/reverse maps.
     * @param repoId - Repository ID
     * @param ctx - Handler context with database access
     * @returns Adjacency cache with forward and reverse maps
     */
    private async getAdjacency(repoId: string, ctx: HandlerContext): Promise<AdjacencyCache> {
        const existing = this.adjacencyCache.get(repoId);
        if (existing && (Date.now() - existing.timestamp) < CACHE_TTL_MS) {
            return existing;
        }

        log.info('Building adjacency cache', { repoId });

        const forward = new Map<string, string[]>();
        const reverse = new Map<string, string[]>();

        // Load both edge types in parallel
        const [internalEdges, externalEdges] = await Promise.all([
            getEdgesByRepo(ctx, repoId, 'CALLS_INTERNAL'),
            getEdgesByRepo(ctx, repoId, 'CALLS_EXTERNAL'),
        ]);

        const allEdges = [...internalEdges, ...externalEdges];
        for (const edge of allEdges) {
            // Forward: from -> to
            const fwd = forward.get(edge.fromNodeId);
            if (fwd) {
                fwd.push(edge.toNodeId);
            } else {
                forward.set(edge.fromNodeId, [edge.toNodeId]);
            }

            // Reverse: to -> from
            const rev = reverse.get(edge.toNodeId);
            if (rev) {
                rev.push(edge.fromNodeId);
            } else {
                reverse.set(edge.toNodeId, [edge.fromNodeId]);
            }
        }

        const cache: AdjacencyCache = { forward, reverse, timestamp: Date.now() };
        this.adjacencyCache.set(repoId, cache);

        log.info('Adjacency cache built', { edges: allEdges.length, sources: forward.size, targets: reverse.size });
        return cache;
    }

    // ========================================================================
    // NODE RESOLUTION
    // ========================================================================

    /**
     * Resolve a function node ID to a TraceFunctionRef.
     * Results are cached in funcRefCache to avoid repeated DB lookups.
     * @param functionId - Node ID to resolve
     * @param ctx - Handler context with database access
     * @returns Function reference or null if node is not found or not a function
     */
    private async resolveFunction(
        functionId: string,
        ctx: HandlerContext
    ): Promise<TraceFunctionRef | null> {
        if (this.funcRefCache.has(functionId)) {
            return this.funcRefCache.get(functionId) || null;
        }

        const node = await getNode(ctx, functionId);
        if (!node || node.nodeType !== 'function') {
            this.funcRefCache.set(functionId, null);
            return null;
        }

        let file = '';
        let line = 0;
        let endLine = 0;
        let contractName = '';

        try {
            const data = JSON.parse(node.data);
            line = data.lines?.[0] ?? 0;
            endLine = data.lines?.[1] ?? line;

            // Resolve contract info for file path
            if (data.contractId) {
                const contractNode = await getNode(ctx, data.contractId);
                if (contractNode) {
                    contractName = contractNode.name;
                    try {
                        const contractData = JSON.parse(contractNode.data);
                        file = contractData.path || '';
                    } catch {
                        // Contract data parse failed, leave file empty
                    }
                }
            }
        } catch {
            // Data parse failed, use defaults
        }

        const ref: TraceFunctionRef = {
            function_id: functionId,
            contract: contractName,
            function_name: node.name,
            file,
            line,
            end_line: endLine,
        };

        this.funcRefCache.set(functionId, ref);
        return ref;
    }

    /**
     * Resolve multiple function IDs in bulk, filtering out nulls.
     * @param functionIds - Array of node IDs to resolve
     * @param ctx - Handler context with database access
     * @returns Array of resolved function references (nulls excluded)
     */
    private async resolveFunctions(
        functionIds: string[],
        ctx: HandlerContext
    ): Promise<TraceFunctionRef[]> {
        const refs: TraceFunctionRef[] = [];
        for (const id of functionIds) {
            const ref = await this.resolveFunction(id, ctx);
            if (ref) {
                refs.push(ref);
            }
        }
        return refs;
    }

    // ========================================================================
    // TOOL 1: trace_calls_to - Reverse BFS
    // ========================================================================

    /**
     * Find all code paths from entry points to a target function.
     * Performs reverse BFS following incoming call edges to reconstruct
     * all call chains that reach the target. Entry points are functions
     * with no incoming call edges.
     * @param input - Tool input with repo_id, function_id, and optional limits
     * @param ctx - Handler context with database access
     * @returns Structured result with paths from entry points to target
     */
    private async traceCallsTo(
        input: TraceCallsToInput,
        ctx: HandlerContext
    ): Promise<TraceCallsToOutput> {
        const maxDepth = Math.min(input.max_depth ?? DEFAULT_MAX_DEPTH, MAX_DEPTH_CAP);
        const maxPaths = input.max_paths ?? DEFAULT_MAX_PATHS;

        const targetRef = await this.resolveFunction(input.function_id, ctx);
        if (!targetRef) {
            throw new Error(`Function not found: ${input.function_id}`);
        }

        const adj = await this.getAdjacency(input.repo_id, ctx);
        const paths: string[][] = [];
        let truncated = false;

        // BFS from target backwards, tracking full paths
        // Each queue entry is [currentNode, pathSoFar]
        const queue: Array<[string, string[]]> = [[input.function_id, [input.function_id]]];

        while (queue.length > 0 && paths.length < maxPaths) {
            const [current, pathSoFar] = queue.shift()!;

            if (pathSoFar.length > maxDepth + 1) {
                continue;
            }

            const callers = adj.reverse.get(current) || [];

            if (callers.length === 0) {
                // This is an entry point - we have a complete path
                // Path is in reverse order (target -> ... -> entry), reverse it
                paths.push([...pathSoFar].reverse());
                if (paths.length >= maxPaths) {
                    truncated = true;
                    break;
                }
                continue;
            }

            for (const caller of callers) {
                // Cycle detection: skip if already in this path
                if (pathSoFar.includes(caller)) {
                    continue;
                }

                if (paths.length >= maxPaths) {
                    truncated = true;
                    break;
                }

                queue.push([caller, [...pathSoFar, caller]]);
            }
        }

        // If we still have items in queue, we truncated
        if (queue.length > 0) {
            truncated = true;
        }

        // Resolve all unique function IDs across paths
        const resolvedPaths: TraceFunctionRef[][] = [];
        for (const path of paths) {
            const resolvedPath = await this.resolveFunctions(path, ctx);
            if (resolvedPath.length > 0) {
                resolvedPaths.push(resolvedPath);
            }
        }

        return {
            target: targetRef,
            paths: resolvedPaths,
            total_paths_found: resolvedPaths.length,
            truncated,
        };
    }

    // ========================================================================
    // TOOL 2: trace_calls_from - Forward DFS
    // ========================================================================

    /**
     * Find all functions reachable from a starting function.
     * Performs forward DFS following outgoing call edges. Builds a tree
     * structure and flat list of all reachable functions. Uses a visited
     * set for cycle detection.
     * @param input - Tool input with repo_id, function_id, and optional max_depth
     * @param ctx - Handler context with database access
     * @returns Structured result with tree and flat reachable list
     */
    private async traceCallsFrom(
        input: TraceCallsFromInput,
        ctx: HandlerContext
    ): Promise<TraceCallsFromOutput> {
        const maxDepth = Math.min(input.max_depth ?? DEFAULT_MAX_DEPTH, MAX_DEPTH_CAP);

        const sourceRef = await this.resolveFunction(input.function_id, ctx);
        if (!sourceRef) {
            throw new Error(`Function not found: ${input.function_id}`);
        }

        const adj = await this.getAdjacency(input.repo_id, ctx);
        const visited = new Set<string>();
        const reachableIds: string[] = [];

        // Build tree via DFS
        const buildTree = async (nodeId: string, depth: number): Promise<TraceTreeNode | null> => {
            if (depth > maxDepth || visited.has(nodeId)) {
                return null;
            }

            visited.add(nodeId);

            const ref = await this.resolveFunction(nodeId, ctx);
            if (!ref) {
                return null;
            }

            // Only add to reachable if not the source itself
            if (nodeId !== input.function_id) {
                reachableIds.push(nodeId);
            }

            const children: TraceTreeNode[] = [];
            const callees = adj.forward.get(nodeId) || [];

            for (const calleeId of callees) {
                const childTree = await buildTree(calleeId, depth + 1);
                if (childTree) {
                    children.push(childTree);
                }
            }

            return {
                function: ref,
                depth,
                children,
            };
        };

        const tree = await buildTree(input.function_id, 0);
        if (!tree) {
            throw new Error(`Could not build trace tree from: ${input.function_id}`);
        }

        const reachable = await this.resolveFunctions(reachableIds, ctx);

        return {
            source: sourceRef,
            reachable,
            tree,
            total_reachable: reachable.length,
        };
    }

    // ========================================================================
    // TOOL 3: trace_interacting_functions
    // ========================================================================

    /**
     * Get immediate callers and callees of a function with optional state
     * variable overlap analysis. When include_state_access is true, also
     * queries READS/WRITES edges and cross-references callers/callees to
     * find functions that share state variables with the target.
     * @param input - Tool input with repo_id, function_id, and optional flag
     * @param ctx - Handler context with database access
     * @returns Structured result with callers, callees, and optional state info
     */
    private async traceInteracting(
        input: TraceInteractingInput,
        ctx: HandlerContext
    ): Promise<TraceInteractingOutput> {
        const funcRef = await this.resolveFunction(input.function_id, ctx);
        if (!funcRef) {
            throw new Error(`Function not found: ${input.function_id}`);
        }

        // Get one-hop callers and callees via direct edge queries
        const [incomingInternal, incomingExternal, outgoingInternal, outgoingExternal] = await Promise.all([
            getEdgesTo(ctx, input.function_id, 'CALLS_INTERNAL'),
            getEdgesTo(ctx, input.function_id, 'CALLS_EXTERNAL'),
            getEdgesFrom(ctx, input.function_id, 'CALLS_INTERNAL'),
            getEdgesFrom(ctx, input.function_id, 'CALLS_EXTERNAL'),
        ]);

        const callerIds = [...new Set([
            ...incomingInternal.map((e: any) => e.fromNodeId),
            ...incomingExternal.map((e: any) => e.fromNodeId),
        ])];

        const calleeIds = [...new Set([
            ...outgoingInternal.map((e: any) => e.toNodeId),
            ...outgoingExternal.map((e: any) => e.toNodeId),
        ])];

        const callers = await this.resolveFunctions(callerIds, ctx);
        const callees = await this.resolveFunctions(calleeIds, ctx);

        const result: TraceInteractingOutput = {
            function: funcRef,
            callers,
            callees,
        };

        // Optional state access analysis
        if (input.include_state_access) {
            const [readEdges, writeEdges] = await Promise.all([
                getEdgesFrom(ctx, input.function_id, 'READS'),
                getEdgesFrom(ctx, input.function_id, 'WRITES'),
            ]);

            const readVarIds = readEdges.map((e: any) => e.toNodeId);
            const writeVarIds = writeEdges.map((e: any) => e.toNodeId);

            result.reads = readVarIds;
            result.writes = writeVarIds;

            // Find state overlaps: other functions that read/write the same vars
            const allVarIds = [...new Set([...readVarIds, ...writeVarIds])];
            const relatedFuncIds = [...callerIds, ...calleeIds];

            if (allVarIds.length > 0 && relatedFuncIds.length > 0) {
                const overlaps: StateOverlap[] = [];

                for (const varId of allVarIds) {
                    // Find all functions that access this var
                    const [varReadEdges, varWriteEdges] = await Promise.all([
                        getEdgesTo(ctx, varId, 'READS'),
                        getEdgesTo(ctx, varId, 'WRITES'),
                    ]);

                    const accessorIds = [...new Set([
                        ...varReadEdges.map((e: any) => e.fromNodeId),
                        ...varWriteEdges.map((e: any) => e.fromNodeId),
                    ])];

                    // Filter to only callers/callees that also access this var
                    const overlappingIds = accessorIds.filter(
                        id => id !== input.function_id && relatedFuncIds.includes(id)
                    );

                    if (overlappingIds.length > 0) {
                        const overlappingFuncs = await this.resolveFunctions(overlappingIds, ctx);
                        // Resolve var name from node
                        const varNode = await getNode(ctx, varId);
                        overlaps.push({
                            state_var: varNode?.name || varId,
                            state_var_id: varId,
                            functions: overlappingFuncs,
                        });
                    }
                }

                result.state_overlaps = overlaps;
            } else {
                result.state_overlaps = [];
            }
        }

        return result;
    }

    // ========================================================================
    // TOOLS 4 & 5: trace_read_slot / trace_write_slot
    // ========================================================================

    /**
     * Find all functions that read or write a specific state variable.
     * Searches for matching state variable nodes in the repo, then finds
     * all functions with the specified edge type to those variables.
     * Falls back to partial name matching if exact match finds nothing.
     * @param input - Tool input with repo_id and state_var_name
     * @param edgeType - 'READS' or 'WRITES'
     * @param ctx - Handler context with database access
     * @returns Structured result with matching vars and accessing functions
     */
    private async traceSlot(
        input: TraceSlotInput,
        edgeType: 'READS' | 'WRITES',
        ctx: HandlerContext
    ): Promise<TraceSlotOutput> {
        // Find state variable nodes matching the name
        const allVarNodes = await getNodesByRepo(ctx, input.repo_id, 'statevar');
        const matchingVars = allVarNodes.filter((n: any) => n.name === input.state_var_name);

        if (matchingVars.length === 0) {
            // Try partial match as fallback (var name might have contract prefix)
            const partialMatches = allVarNodes.filter((n: any) =>
                n.name.toLowerCase().includes(input.state_var_name.toLowerCase()) ||
                n.nodeId.toLowerCase().includes(input.state_var_name.toLowerCase())
            );

            if (partialMatches.length === 0) {
                return {
                    state_var_name: input.state_var_name,
                    matching_vars: [],
                    functions: [],
                };
            }

            return this.resolveSlotAccess(input.state_var_name, partialMatches, edgeType, ctx);
        }

        return this.resolveSlotAccess(input.state_var_name, matchingVars, edgeType, ctx);
    }

    /**
     * Resolve all functions that access the given state variable nodes.
     * READS/WRITES edges go FROM function TO statevar, so we query
     * edges pointing TO each var node and collect the source functions.
     * @param varName - Original variable name from the query
     * @param varNodes - Matching state variable node rows
     * @param edgeType - 'READS' or 'WRITES'
     * @param ctx - Handler context with database access
     * @returns Structured result with matching vars and accessing functions
     */
    private async resolveSlotAccess(
        varName: string,
        varNodes: any[],
        edgeType: 'READS' | 'WRITES',
        ctx: HandlerContext
    ): Promise<TraceSlotOutput> {
        const matchingVarIds = varNodes.map((n: any) => n.nodeId);
        const functionIds = new Set<string>();

        // For each matching var, find all functions with the given edge type
        // Note: READS/WRITES edges go FROM function TO statevar
        for (const varNode of varNodes) {
            const edges = await getEdgesTo(ctx, varNode.nodeId, edgeType);
            for (const edge of edges) {
                functionIds.add(edge.fromNodeId);
            }
        }

        const functions = await this.resolveFunctions([...functionIds], ctx);

        return {
            state_var_name: varName,
            matching_vars: matchingVarIds,
            functions,
        };
    }
}
