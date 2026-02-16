/**
 * @fileoverview Graph walker for pipeline DAG traversal
 * @module sera-core/pipeline/GraphWalker
 *
 * Manages the execution order of nodes in a pipeline DAG using Kahn's algorithm
 * for topological ordering. Tracks ready, active, completed, failed, and skipped
 * node sets with output storage for data flow between nodes.
 */

import type {
    PipelineSpec,
    PipelineNode,
    PipelineEdge,
    GraphWalkerState,
    NodeOutput,
    NodeInput,
} from '@sera/types';

// ============================================================================
// TOPOLOGICAL SORT
// ============================================================================

/**
 * Compute a topological ordering of nodes using Kahn's algorithm.
 * @param spec - Pipeline specification
 * @returns Array of node IDs in topological order
 * @throws If the graph contains a cycle
 */
export function computeTopologicalOrder(spec: PipelineSpec): string[] {
    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();

    for (const node of spec.nodes) {
        inDegree.set(node.id, 0);
        adjacency.set(node.id, []);
    }

    for (const edge of spec.edges) {
        if (adjacency.has(edge.source) && inDegree.has(edge.target)) {
            adjacency.get(edge.source)!.push(edge.target);
            inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
        }
    }

    const queue: string[] = [];
    for (const [id, degree] of inDegree) {
        if (degree === 0) queue.push(id);
    }

    const order: string[] = [];
    while (queue.length > 0) {
        const current = queue.shift()!;
        order.push(current);
        for (const neighbor of adjacency.get(current) ?? []) {
            const newDegree = (inDegree.get(neighbor) ?? 0) - 1;
            inDegree.set(neighbor, newDegree);
            if (newDegree === 0) queue.push(neighbor);
        }
    }

    if (order.length !== spec.nodes.length) {
        throw new Error('Pipeline graph contains a cycle');
    }

    return order;
}

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

/**
 * Create initial walker state with the entry node in the ready queue.
 * @param spec - Pipeline specification
 * @returns Initial graph walker state
 */
export function initializeState(spec: PipelineSpec): GraphWalkerState {
    return {
        readyQueue: [spec.entryNodeId],
        activeSet: [],
        completedSet: [],
        failedSet: [],
        skippedSet: [],
        resultStore: {},
    };
}

/**
 * Get nodes that are ready to execute (all dependencies completed or skipped).
 * @param state - Current walker state
 * @param spec - Pipeline specification
 * @returns Node IDs that can be dispatched
 */
export function getReadyNodes(state: GraphWalkerState, spec: PipelineSpec): string[] {
    const ready: string[] = [];

    for (const nodeId of state.readyQueue) {
        // Get all incoming edges
        const incomingEdges = spec.edges.filter(e => e.target === nodeId);

        // A node is ready if all its dependencies are completed or skipped
        const allDependenciesMet = incomingEdges.every(edge => {
            const sourceId = edge.source;
            return state.completedSet.includes(sourceId) || state.skippedSet.includes(sourceId);
        });

        // Entry node has no incoming edges, always ready
        if (incomingEdges.length === 0 || allDependenciesMet) {
            ready.push(nodeId);
        }
    }

    return ready;
}

/**
 * Move a node from ready queue to active set.
 * @param state - Walker state (mutated)
 * @param nodeId - Node to start
 */
export function markNodeStarted(state: GraphWalkerState, nodeId: string): void {
    state.readyQueue = state.readyQueue.filter(id => id !== nodeId);
    if (!state.activeSet.includes(nodeId)) {
        state.activeSet.push(nodeId);
    }
}

/**
 * Move a node from active set to completed set, store output, and update ready queue.
 * @param state - Walker state (mutated)
 * @param nodeId - Node that completed
 * @param output - Output produced by the node
 * @param spec - Pipeline specification (for finding downstream nodes)
 */
export function markNodeCompleted(
    state: GraphWalkerState,
    nodeId: string,
    output: NodeOutput,
    spec: PipelineSpec
): void {
    state.activeSet = state.activeSet.filter(id => id !== nodeId);
    if (!state.completedSet.includes(nodeId)) {
        state.completedSet.push(nodeId);
    }
    state.resultStore[nodeId] = output;

    // Find downstream nodes and add to ready queue if not already there
    const outgoing = spec.edges.filter(e => e.source === nodeId);
    for (const edge of outgoing) {
        if (
            !state.readyQueue.includes(edge.target) &&
            !state.activeSet.includes(edge.target) &&
            !state.completedSet.includes(edge.target) &&
            !state.failedSet.includes(edge.target) &&
            !state.skippedSet.includes(edge.target)
        ) {
            state.readyQueue.push(edge.target);
        }
    }
}

/**
 * Move a node from active set to failed set and handle error edges.
 * @param state - Walker state (mutated)
 * @param nodeId - Node that failed
 * @param spec - Pipeline specification (for finding error edges)
 */
export function markNodeFailed(
    state: GraphWalkerState,
    nodeId: string,
    spec: PipelineSpec
): void {
    state.activeSet = state.activeSet.filter(id => id !== nodeId);
    if (!state.failedSet.includes(nodeId)) {
        state.failedSet.push(nodeId);
    }

    // Check for error edges
    const errorEdges = spec.edges.filter(e => e.source === nodeId && e.type === 'error');
    for (const edge of errorEdges) {
        if (
            !state.readyQueue.includes(edge.target) &&
            !state.activeSet.includes(edge.target) &&
            !state.completedSet.includes(edge.target) &&
            !state.failedSet.includes(edge.target) &&
            !state.skippedSet.includes(edge.target)
        ) {
            state.readyQueue.push(edge.target);
        }
    }

    // If no error edges, skip downstream nodes that depend only on this node
    if (errorEdges.length === 0) {
        skipUnreachableDownstream(state, nodeId, spec);
    }
}

/**
 * Mark a node as skipped.
 */
export function markNodeSkipped(state: GraphWalkerState, nodeId: string): void {
    state.readyQueue = state.readyQueue.filter(id => id !== nodeId);
    state.activeSet = state.activeSet.filter(id => id !== nodeId);
    if (!state.skippedSet.includes(nodeId)) {
        state.skippedSet.push(nodeId);
    }
}

/**
 * Evaluate conditional edges from a condition node and return target IDs that should fire.
 * @param spec - Pipeline specification
 * @param nodeId - The condition node ID
 * @param outputs - Resolved outputs from the condition node
 * @param variables - Pipeline variables
 * @returns Target node IDs whose conditions evaluated to true
 */
export function evaluateConditionalEdges(
    spec: PipelineSpec,
    nodeId: string,
    outputs: Record<string, unknown>,
    variables: Record<string, unknown>
): string[] {
    const conditionalEdges = spec.edges
        .filter(e => e.source === nodeId && e.type === 'conditional')
        .sort((a, b) => {
            const priorityA = (a.config?.priority as number) ?? 50;
            const priorityB = (b.config?.priority as number) ?? 50;
            return priorityB - priorityA; // Higher priority first
        });

    const targets: string[] = [];
    for (const edge of conditionalEdges) {
        const expression = (edge.config?.expression as string) ?? 'true';
        try {
            // Expression authored by pipeline creator, not untrusted input
            const fn = new Function('inputs', 'variables', `return Boolean(${expression})`);
            if (fn(outputs, variables)) {
                targets.push(edge.target);
            }
        } catch {
            // Skip edges with invalid expressions
        }
    }

    return targets;
}

/**
 * Resolve inputs for a node by gathering outputs from upstream nodes.
 * @param spec - Pipeline specification
 * @param nodeId - Node to resolve inputs for
 * @param state - Current walker state (has resultStore)
 * @returns Resolved inputs keyed by port name
 */
export function resolveNodeInputs(
    spec: PipelineSpec,
    nodeId: string,
    state: GraphWalkerState
): NodeInput {
    const inputs: NodeInput = {};
    const incomingEdges = spec.edges.filter(e => e.target === nodeId);

    for (const edge of incomingEdges) {
        const sourceOutput = state.resultStore[edge.source];
        if (!sourceOutput) continue;

        const portName = edge.targetPort ?? edge.sourcePort ?? 'default';

        if (edge.type === 'data' && edge.config?.fieldMappings) {
            // Apply field mappings for data edges
            const mappings = edge.config.fieldMappings as Array<{ source: string; target: string }>;
            const mapped: Record<string, unknown> = {};
            const sourceData = sourceOutput.data as Record<string, unknown>;
            for (const mapping of mappings) {
                mapped[mapping.target] = sourceData[mapping.source];
            }
            inputs[portName] = { type: sourceOutput.type, data: mapped };
        } else if (edge.type === 'parallel-join') {
            // Aggregate parallel results
            const aggregation = (edge.config?.aggregation as string) ?? 'array';
            if (inputs[portName]) {
                // Merge with existing
                const existing = inputs[portName];
                if (aggregation === 'array') {
                    const arr = Array.isArray(existing.data) ? existing.data : [existing.data];
                    arr.push(sourceOutput.data);
                    inputs[portName] = { type: 'aggregated', data: arr };
                } else {
                    // merge strategy
                    inputs[portName] = {
                        type: 'aggregated',
                        data: { ...existing.data as Record<string, unknown>, ...sourceOutput.data as Record<string, unknown> },
                    };
                }
            } else {
                inputs[portName] = aggregation === 'array'
                    ? { type: 'aggregated', data: [sourceOutput.data] }
                    : sourceOutput;
            }
        } else {
            inputs[portName] = sourceOutput;
        }
    }

    return inputs;
}

// ============================================================================
// HELPERS
// ============================================================================

function skipUnreachableDownstream(
    state: GraphWalkerState,
    failedNodeId: string,
    spec: PipelineSpec
): void {
    // Find nodes that only depend on the failed node (no other paths)
    const outgoing = spec.edges.filter(e => e.source === failedNodeId && e.type !== 'error');
    for (const edge of outgoing) {
        const otherIncoming = spec.edges.filter(
            e => e.target === edge.target && e.source !== failedNodeId
        );
        // If this node has no other incoming edges, skip it
        if (otherIncoming.length === 0) {
            markNodeSkipped(state, edge.target);
            skipUnreachableDownstream(state, edge.target, spec);
        }
    }
}
