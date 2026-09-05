import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  external: ['vscode'],
  format: 'cjs',
  mainFields: ['module', 'main'],
  minify: false,
  platform: 'node',
  sourcemap: true,
  outfile: 'dist/extension.js',
  target: 'node18'
};

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
  console.log('Watching Smart Snippets sources...');
} else {
  await esbuild.build(options);
}
