import { mkdir,writeFile,cp } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { homedir } from 'node:os';
const home=resolve('.sandbox/home');const profile=join(home,'profiles/web');
const destination=join(profile,'node_modules/dsh-usage-stats-local');await mkdir(destination,{recursive:true});
for(const name of ['lib','package.json','cordis.patch.yml'])await cp(name,join(destination,name),{recursive:true});
await writeFile(join(profile,'package.json'),JSON.stringify({name:'usage-stats-test-profile',private:true,dependencies:{'dsh-usage-stats-local':'file:'+resolve('.')},dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','dsh-usage-stats-local']}}},null,2));
await writeFile(join(profile,'cordis.yml'),'[]\n');await writeFile(join(profile,'cordis.patch.yml'),'[]\n');
// Copy snapshots for integration QA only. No account credentials or configuration.
await cp(join(homedir(),'.dsh/sessions'),join(home,'sessions'),{recursive:true});
console.log('Isolated DSH_HOME: '+home);
