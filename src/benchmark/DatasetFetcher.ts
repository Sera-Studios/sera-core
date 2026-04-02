/**
 * @fileoverview Dataset fetcher interface and registry
 * @module sera-core/benchmark/DatasetFetcher
 *
 * Fetchers are pluggable functions that extract data from external sources
 * (e.g. Sherlock contest repos) and produce structured datasets for benchmarking.
 */

import type { BenchmarkDataset } from '@sera/types';

/**
 * Result from a fetcher - dataset metadata + ground truth data
 */
export interface FetcherResult {
    /** Dataset metadata to store */
    dataset: Omit<BenchmarkDataset, 'id' | 'fetchedAt'>;
    /** Ground truth data - shape depends on fetcher */
    groundTruth: unknown;
}

/**
 * A pluggable dataset fetcher that extracts data from an external source
 */
export interface DatasetFetcher {
    /** Unique fetcher ID (e.g. 'valid-findings') */
    readonly id: string;
    /** Human-readable display name */
    readonly name: string;
    /** Human-readable description */
    readonly description: string;
    /** Which source types this fetcher supports */
    readonly supportedSources: string[];

    /**
     * Fetch and structure data from an external source.
     * Called once during dataset import. The store handles persistence.
     */
    fetch(
        sourceId: string,
        sourceType: string,
        options: Record<string, string>,
    ): Promise<FetcherResult>;
}

/**
 * Registry for dataset fetchers
 */
export class FetcherRegistry {
    private fetchers = new Map<string, DatasetFetcher>();

    register(fetcher: DatasetFetcher): void {
        this.fetchers.set(fetcher.id, fetcher);
    }

    get(id: string): DatasetFetcher | undefined {
        return this.fetchers.get(id);
    }

    list(): Array<{ id: string; name: string; description: string; sourceTypes: string[] }> {
        return [...this.fetchers.values()].map(f => ({
            id: f.id,
            name: f.name,
            description: f.description,
            sourceTypes: f.supportedSources,
        }));
    }
}
