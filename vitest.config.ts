import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        root: '.',
        include: ['src/**/*.test.ts'],
        singleFork: true,
        testTimeout: 30000,
        deps: {
            interopDefault: true,
        },
    },
});
