import { build } from 'esbuild';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
// The host displays package.description in its installed-plugin list.
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const description = manifest.description.replace(/^v\S+\s*·\s*/, '');
const displayDescription = `v${manifest.version} · ${description}`;
if (manifest.description !== displayDescription) {
  manifest.description = displayDescription;
  await writeFile('package.json', JSON.stringify(manifest, null, 2) + '\n');
}
await mkdir('dist',{recursive:true});
await build({entryPoints:['src/index.js'],outfile:'lib/index.js',bundle:true,platform:'node',format:'esm',target:'node24',sourcemap:false});
await copyFile('src/update-on-exit.mjs', 'lib/update-on-exit.mjs');
await build({entryPoints:['src/client/index.jsx'],outfile:'lib/client.js',bundle:true,platform:'browser',format:'cjs',target:'chrome130',jsx:'automatic',loader:{'.css':'text'},external:['react','react/jsx-runtime','react-dom','react-dom/client'],define:{'process.env.NODE_ENV':'"production"'},minify:true,
  banner:{js:'window.__ModuleLoader__.load({id:"dsh-usage-stats-local",factory:(require)=>{var module={exports:{}};var exports=module.exports;'},footer:{js:'return module.exports;}});'}});
console.log('Built lib/index.js and lib/client.js');
