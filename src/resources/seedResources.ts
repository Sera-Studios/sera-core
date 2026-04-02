/**
 * @fileoverview Seed audit knowledge resources from filesystem into ResourceStore
 * @module sera-core/resources/seedResources
 *
 * Reads markdown files from the resources/ directory and upserts them into the
 * SQLite resource database. Supports roles, primers, references, articles, and reports.
 */

import * as fs from 'fs';
import * as path from 'path';

import { ResourceStore, ResourceCreateInput } from './ResourceStore';
import type { ResourceType, ResourceLanguage } from '@sera/types';

export interface SeedResult {
    seeded: number;
    skipped: number;
    errors: string[];
}

/**
 * Seed resources from a filesystem directory into the ResourceStore.
 * Uses upsert so it's safe to run multiple times.
 */
export function seedResources(store: ResourceStore, resourcesDir: string): SeedResult {
    const result: SeedResult = { seeded: 0, skipped: 0, errors: [] };

    if (!fs.existsSync(resourcesDir)) {
        result.errors.push(`Resources directory not found: ${resourcesDir}`);
        return result;
    }

    // Seed each category
    seedDirectory(store, path.join(resourcesDir, 'roles'), 'role', result);
    seedDirectory(store, path.join(resourcesDir, 'agents'), 'article', result);
    seedPrimers(store, path.join(resourcesDir, 'primers'), result);
    seedDirectory(store, path.join(resourcesDir, 'references', 'vulnerabilities'), 'reference', result);
    seedReports(store, path.join(resourcesDir, 'reports'), result);

    return result;
}

/**
 * Seed a flat directory of markdown files as a given resource type.
 * Language defaults to 'any' unless detected from the path or filename.
 */
function seedDirectory(
    store: ResourceStore,
    dir: string,
    type: ResourceType,
    result: SeedResult,
    language?: ResourceLanguage,
    extraTags?: string[],
): void {
    if (!fs.existsSync(dir)) return;

    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));

    for (const file of files) {
        try {
            const filePath = path.join(dir, file);
            const content = fs.readFileSync(filePath, 'utf-8');
            const name = nameFromFilename(file);

            const input: ResourceCreateInput = {
                type,
                language: language || 'any',
                name,
                content,
                tags: [...(extraTags || []), type],
            };

            store.upsert(input);
            result.seeded++;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            result.errors.push(`${type}/${file}: ${msg}`);
        }
    }
}

/**
 * Seed primers from subdirectory structure.
 * Each subdirectory name becomes a tag (e.g., primers/staking/ -> tag "staking").
 */
function seedPrimers(store: ResourceStore, primersDir: string, result: SeedResult): void {
    if (!fs.existsSync(primersDir)) return;

    const subdirs = fs.readdirSync(primersDir, { withFileTypes: true })
        .filter(d => d.isDirectory());

    for (const subdir of subdirs) {
        const subPath = path.join(primersDir, subdir.name);
        seedDirectory(store, subPath, 'primer', result, undefined, [subdir.name]);
    }
}

/**
 * Seed reports - only markdown files, skipping PDFs and other binary formats.
 * Walks subdirectories recursively. Uses subdirectory name as a tag.
 */
function seedReports(store: ResourceStore, reportsDir: string, result: SeedResult): void {
    if (!fs.existsSync(reportsDir)) return;

    walkMarkdownFiles(reportsDir, (filePath, relativePath) => {
        try {
            let content = fs.readFileSync(filePath, 'utf-8');
            const name = nameFromFilename(path.basename(filePath));

            // Strip YAML frontmatter if present
            content = stripFrontmatter(content);

            // Use parent directory name as tag
            const parentDir = path.dirname(relativePath);
            const tags = ['report'];
            if (parentDir !== '.') {
                tags.push(parentDir.split(path.sep)[0]);
            }

            const input: ResourceCreateInput = {
                type: 'report',
                language: 'any',
                name,
                content,
                tags,
            };

            store.upsert(input);
            result.seeded++;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            result.errors.push(`report/${relativePath}: ${msg}`);
        }
    });
}

/**
 * Walk a directory recursively, calling the callback for each .md file.
 */
function walkMarkdownFiles(
    dir: string,
    callback: (filePath: string, relativePath: string) => void,
    baseDir?: string,
): void {
    const base = baseDir || dir;
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            // Skip hidden directories
            if (!entry.name.startsWith('.')) {
                walkMarkdownFiles(fullPath, callback, base);
            }
        } else if (entry.name.endsWith('.md')) {
            callback(fullPath, path.relative(base, fullPath));
        }
    }
}

/**
 * Strip YAML frontmatter (--- delimited) from markdown content.
 */
function stripFrontmatter(content: string): string {
    if (!content.startsWith('---')) return content;

    const endIndex = content.indexOf('---', 3);
    if (endIndex === -1) return content;

    return content.substring(endIndex + 3).trimStart();
}

/**
 * Derive a display name from a filename.
 * Strips extensions, replaces hyphens/underscores with spaces, title-cases.
 */
function nameFromFilename(filename: string): string {
    return filename
        .replace(/\.primer\.md$/, '')
        .replace(/\.md$/, '')
        .replace(/[-_]+/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase())
        .trim();
}
