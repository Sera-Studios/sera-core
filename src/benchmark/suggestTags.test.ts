/**
 * @fileoverview Unit tests for suggestTags and suggestDifficulty
 */

import { describe, it, expect } from 'vitest';
import { suggestTags, suggestDifficulty } from './suggestTags';

describe('suggestTags', () => {
    it('always includes source and language', () => {
        const tags = suggestTags({
            source: 'sherlock',
            language: 'solidity',
            name: 'Generic Protocol',
            totalFindings: 5,
        });
        expect(tags).toContain('sherlock');
        expect(tags).toContain('solidity');
    });

    it('defaults language to solidity when not provided', () => {
        const tags = suggestTags({
            source: 'code4rena',
            name: 'Some Contest',
            totalFindings: 5,
        });
        expect(tags).toContain('solidity');
    });

    it('detects lending domain', () => {
        const tags = suggestTags({
            source: 'sherlock',
            name: 'Aave Lending Pool V3',
            totalFindings: 10,
        });
        expect(tags).toContain('lending');
    });

    it('detects borrow keyword as lending', () => {
        const tags = suggestTags({
            source: 'sherlock',
            name: 'Flash Borrow Protocol',
            totalFindings: 5,
        });
        expect(tags).toContain('lending');
    });

    it('detects AMM domain via amm keyword', () => {
        const tags = suggestTags({
            source: 'sherlock',
            name: 'UniswapV4 AMM Core',
            totalFindings: 15,
        });
        expect(tags).toContain('amm');
    });

    it('detects AMM domain via swap keyword', () => {
        const tags = suggestTags({
            source: 'sherlock',
            name: 'Token Swap Protocol',
            totalFindings: 10,
        });
        expect(tags).toContain('amm');
    });

    it('detects AMM domain via dex keyword', () => {
        const tags = suggestTags({
            source: 'sherlock',
            name: 'New DEX Implementation',
            totalFindings: 10,
        });
        expect(tags).toContain('amm');
    });

    it('detects vault domain', () => {
        const tags = suggestTags({
            source: 'sherlock',
            name: 'ERC4626 Vault Strategy',
            totalFindings: 8,
        });
        expect(tags).toContain('vault');
    });

    it('detects vault domain via yield keyword', () => {
        const tags = suggestTags({
            source: 'sherlock',
            name: 'Yield Aggregator v2',
            totalFindings: 8,
        });
        expect(tags).toContain('vault');
    });

    it('detects bridge domain', () => {
        const tags = suggestTags({
            source: 'code4rena',
            name: 'LayerZero Bridge Audit',
            totalFindings: 20,
        });
        expect(tags).toContain('bridge');
    });

    it('detects bridge domain via cross-chain keyword', () => {
        const tags = suggestTags({
            source: 'sherlock',
            name: 'Cross-Chain Messaging',
            totalFindings: 12,
        });
        expect(tags).toContain('bridge');
    });

    it('detects governance domain', () => {
        const tags = suggestTags({
            source: 'sherlock',
            name: 'DAO Governance Module',
            totalFindings: 7,
        });
        expect(tags).toContain('governance');
    });

    it('detects governance via dao keyword', () => {
        const tags = suggestTags({
            source: 'sherlock',
            name: 'Protocol DAO Implementation',
            totalFindings: 7,
        });
        expect(tags).toContain('governance');
    });

    it('detects NFT domain', () => {
        const tags = suggestTags({
            source: 'sherlock',
            name: 'NFT Marketplace v2',
            totalFindings: 10,
        });
        expect(tags).toContain('nft');
    });

    it('detects NFT domain via erc721 keyword', () => {
        const tags = suggestTags({
            source: 'sherlock',
            name: 'ERC721 Extensions',
            totalFindings: 3,
        });
        expect(tags).toContain('nft');
    });

    it('detects staking domain', () => {
        const tags = suggestTags({
            source: 'code4rena',
            name: 'Liquid Staking Derivatives',
            totalFindings: 25,
        });
        expect(tags).toContain('staking');
    });

    it('detects multiple domains in one name', () => {
        const tags = suggestTags({
            source: 'sherlock',
            name: 'AMM Vault with Staking',
            totalFindings: 15,
        });
        expect(tags).toContain('amm');
        expect(tags).toContain('vault');
        expect(tags).toContain('staking');
    });

    it('returns only source and language for unrecognized domain', () => {
        const tags = suggestTags({
            source: 'cantina',
            language: 'rust',
            name: 'Generic Smart Contract',
            totalFindings: 5,
        });
        expect(tags).toEqual(['cantina', 'rust']);
    });
});

describe('suggestDifficulty', () => {
    it('returns easy for 10 or fewer findings', () => {
        expect(suggestDifficulty(0)).toBe('easy');
        expect(suggestDifficulty(5)).toBe('easy');
        expect(suggestDifficulty(10)).toBe('easy');
    });

    it('returns medium for 11-30 findings', () => {
        expect(suggestDifficulty(11)).toBe('medium');
        expect(suggestDifficulty(20)).toBe('medium');
        expect(suggestDifficulty(30)).toBe('medium');
    });

    it('returns hard for more than 30 findings', () => {
        expect(suggestDifficulty(31)).toBe('hard');
        expect(suggestDifficulty(100)).toBe('hard');
    });
});
