import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const output = resolve(process.argv[2] ?? 'tmp/finance-pdf-render-linux');
const image = process.argv[3];
if (!image) throw new Error('usage: build-linux-artifact.mjs <output> <locally-installed-linux-dependency-image>');
const docker = (args, options={}) => execFileSync('docker',args,{encoding:'utf8',...options});
const inspected=JSON.parse(docker(['image','inspect',image]))[0];
if(inspected.Os !== 'linux') throw new Error('linux-image-required');
const imageId=inspected.Id;
execFileSync(process.execPath,[join(dirname(fileURLToPath(import.meta.url)),'build.mjs'),output],{stdio:'inherit'});
const script=`const {createRequire}=require('node:module');const r=createRequire('/app/package.json');let pdf;try{pdf=r.resolve('pdfjs-dist/package.json')}catch{pdf=createRequire(r.resolve('pdf-parse')).resolve('pdfjs-dist/package.json')};const q=createRequire(pdf);const canvas=q.resolve('@napi-rs/canvas/package.json');const c=createRequire(canvas);const paths=[['pdfjs-dist',pdf],['@napi-rs/canvas',canvas]];if(q(pdf).version!=='5.4.296'||c(canvas).version!=='0.1.80')throw Error('version');for(const name of Object.keys(c(canvas).optionalDependencies)){try{paths.push([name,c.resolve(name+'/package.json')])}catch{}};if(paths.length<3)throw Error('native-unavailable');console.log(JSON.stringify(paths));`;
const paths=JSON.parse(docker(['run','--rm','--platform',`linux/${inspected.Architecture}`,'--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--entrypoint','node',imageId,'-e',script]));
await rm(join(output,'node_modules'),{recursive:true,force:true});
const container=docker(['create','--platform',`linux/${inspected.Architecture}`,'--entrypoint','/bin/true',imageId]).trim();
try {
  for(const [name,path] of paths){
    if(!/^(@napi-rs\/canvas(?:-[a-z0-9-]+)?|pdfjs-dist)$/.test(name)||!path.startsWith('/app/node_modules/')||!path.endsWith('/package.json'))throw Error('dependency-path-invalid');
    const target=join(output,'node_modules',name);await mkdir(target,{recursive:true});
    docker(['cp',`${container}:${dirname(path)}/.`,target]);
  }
} finally {docker(['rm',container]);}
await writeFile(join(output,'linux-provenance.json'),JSON.stringify({dependencyImage:imageId,platform:`linux/${inspected.Architecture}`,pdfjsVersion:'5.4.296',canvasVersion:'0.1.80'},null,2));
console.log(`Offline Linux artifact ready: ${output} (${inspected.Architecture})`);
