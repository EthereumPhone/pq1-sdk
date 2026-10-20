import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    transport: 'src/transport/index.ts',
    aa: 'src/aa/index.ts',
    'clear-signing': 'src/clear-signing.ts',
    provider: 'src/provider/index.ts',
    extension: 'src/extension/index.ts',
    testing: 'src/testing/index.ts'
  },
  format: ['esm', 'cjs'],
  dts: true,
  // Shared chunks keep one copy of each class across entry points, so
  // `instanceof Pq1Error` works whichever subpath an error came from.
  splitting: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: 'es2022',
  external: ['viem']
})
