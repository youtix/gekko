import path from 'node:path';

export default {
  test: {
    mockReset: true,
    restoreMocks: true,
    // scripts/release holds the release's own semantic-release plugin
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    coverage: {
      reporter: ['text'],
      include: ['src/**/*.ts', 'scripts/**/*.cjs'],
      exclude: [
        'src/**/*.{schema,mock,types,error,const}.ts',
        'src/**/*.bench.ts',
        'src/**/index.ts',
        'src/strategies/custom/**/*.ts',
        'src/strategies/debug/**/*.ts',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
  resolve: {
    alias: {
      '@constants': path.resolve(__dirname, './src/constants'),
      '@models': path.resolve(__dirname, './src/models'),
      '@errors': path.resolve(__dirname, './src/errors'),
      '@utils': path.resolve(__dirname, './src/utils'),
      '@services': path.resolve(__dirname, './src/services'),
      '@indicators': path.resolve(__dirname, './src/indicators'),
      '@strategies': path.resolve(__dirname, './src/strategies'),
      '@plugins': path.resolve(__dirname, './src/plugins'),
    },
  },
};
