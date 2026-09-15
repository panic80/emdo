import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { chmod, lstat, unlink } from 'node:fs/promises';
const path='/run/emdo/finance-pdf-render/helper.sock';
const helper='/usr/local/bin/emdo-finance-pdf-render-helper';
const maximumBytes=2*1024*1024+4096;
const env={PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/tmp',TMPDIR:'/tmp',LANG:'C',LC_ALL:'C',NODE_NO_WARNINGS:'1'};
try { if(!(await lstat(path)).isSocket()) throw Error('pdf-render-socket-path-invalid'); await unlink(path); }
catch(error){ if(error.code!=='ENOENT') throw error; }
let active;
const server=createServer({allowHalfOpen:true},(socket)=>{
  if(active){socket.destroy();return;}
  const child=spawn(helper,[],{detached:true,stdio:['pipe','pipe','pipe'],cwd:'/tmp',env});
  let received=0,sent=0,diagnostics=0,finished=false;
  const kill=()=>{if(child.pid){try{process.kill(-child.pid,'SIGKILL');}catch{/* Already exited. */}}};
  const stop=()=>{if(finished)return;finished=true;clearTimeout(timer);kill();socket.destroy();child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();};
  active=stop;
  const timer=setTimeout(stop,16000);
  let expected;const requestChunks=[];
  const magic=Buffer.from('EMDO-FINANCE-PDF-RENDER-V1\n');
  socket.on('data',(bytes)=>{
    received+=bytes.length;if(received>maximumBytes||(expected!==undefined&&received>expected)){stop();return;}
    requestChunks.push(Buffer.from(bytes));
    const request=Buffer.concat(requestChunks);
    if(expected===undefined&&request.length>=magic.length+4){
      const headerLength=request.readUInt32BE(magic.length);
      if(!request.subarray(0,magic.length).equals(magic)||headerLength<1||headerLength>2048){stop();return;}
      if(request.length>=magic.length+4+headerLength){
        try {const header=JSON.parse(request.subarray(magic.length+4,magic.length+4+headerLength));
          if(!Number.isInteger(header.byteLength)||header.byteLength<1||header.byteLength>2*1024*1024)throw Error('length');
          expected=magic.length+4+headerLength+header.byteLength;
        }catch{stop();return;}
      }
    }
    if(expected!==undefined){
      if(received>expected){stop();return;}
      if(received===expected){child.stdin.end(request);for(const chunk of requestChunks)chunk.fill(0);requestChunks.length=0;}
    }
  });
  child.stdout.on('data',(bytes)=>{sent+=bytes.length;if(sent>maximumBytes)stop();});
  child.stderr.on('data',(bytes)=>{diagnostics+=bytes.length;if(diagnostics>4096)stop();});
  socket.on('error',stop);socket.on('close',stop);socket.on('end',stop);
  child.stdin.on('error',stop);child.stdout.on('error',stop);child.stderr.on('error',stop);child.on('error',stop);
  child.once('close',(code)=>{
    clearTimeout(timer);active=undefined;
    // Kill surviving descendants even when the immediate helper exited.
    kill();
    if(code!==0)stop();else if(!finished){finished=true;socket.end();}
  });
  child.stdout.pipe(socket,{end:false});
});
server.on('error',()=>{active?.();process.exitCode=1;});
server.listen(path,async()=>{await chmod(path,0o660);});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{active?.();server.close();});
