/**
 * @fileoverview Auto-suggest tags and difficulty for imported contests
 * @module sera-core/benchmark/suggestTags
 */

/**
 * Suggest tags based on contest metadata.
 * Applied at import time as defaults; can be overridden later.
 */
export function suggestTags(contest: {
    source: string;
    language?: string;
    name: string;
    totalFindings: number;
}): string[] {
    const tags: string[] = [];

    // Source
    tags.push(contest.source);

    // Language
    tags.push(contest.language || 'solidity');

    // Domain detection from name
    const text = contest.name.toLowerCase();
    if (text.includes('lend') || text.includes('borrow')) tags.push('lending');
    if (text.includes('amm') || text.includes('swap') || text.includes('dex')) tags.push('amm');
    if (text.includes('vault') || text.includes('yield')) tags.push('vault');
    if (text.includes('bridge') || text.includes('cross-chain')) tags.push('bridge');
    if (text.includes('governance') || text.includes('dao')) tags.push('governance');
    if (text.includes('nft') || text.includes('erc721')) tags.push('nft');
    if (text.includes('staking')) tags.push('staking');

    return tags;
}

/**
 * Suggest difficulty level based on finding count.
 */
export function suggestDifficulty(totalFindings: number): 'easy' | 'medium' | 'hard' {
    if (totalFindings <= 10) return 'easy';
    if (totalFindings <= 30) return 'medium';
    return 'hard';
}
