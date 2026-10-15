// Check the actual archive, not only the development checkout.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const asar=require('@electron/asar');
const root=path.resolve(__dirname,'..'),pkg=require('../package.json');
const base=process.platform==='darwin'?path.join(root,'dist/mac-arm64',pkg.build.productName+'.app','Contents/Resources'):path.join(root,'dist/win-unpacked/resources');
const archive=path.join(base,'app.asar');
const files=['electron/main.js','electron/browserPreload.js','electron/chatViewController.js','electron/shellPopover.js','renderer/browser.html','renderer/studio-shell.js','renderer/studio-shell.css','renderer/glass-skin.css','THIRD_PARTY_NOTICES.md'];
assert.equal(JSON.parse(asar.extractFile(archive,'package.json')).version,pkg.version);
assert.ok(!asar.listPackage(archive).some(file=>/chat-replica|chatReplica|chat-dist|assistant-ui/.test(file)), 'Removed experiment remains in archive');
for(const file of files)assert.deepEqual(asar.extractFile(archive,path.normalize(file)),fs.readFileSync(path.join(root,file)),`Packaged file differs: ${file}`);
const runtime=path.join(base,'resources/coding-tools-mcp');
assert.equal(JSON.parse(fs.readFileSync(path.join(runtime,'schema-contract.json'),'utf8')).runtime_version,pkg.version);
const python=path.join(base,process.platform==='darwin'?'resources/native-python/bin/python3':'resources/native-python/python.exe');
const result=spawnSync(python,['-B','-c','from coding_tools_mcp import __version__; print(__version__)'],{encoding:'utf8',windowsHide:true,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',PYTHONPATH:runtime}});
assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),pkg.version);
async function digest(file,algorithm,encoding){const hash=crypto.createHash(algorithm);for await(const chunk of fs.createReadStream(file))hash.update(chunk);return hash.digest(encoding);}
(async()=>{
  const report={ok:true,version:pkg.version,files:files.length,platform:process.platform};
  if(process.platform==='win32'){
    const name=`web-mcp-assistant-setup-${pkg.version}.exe`,installer=path.join(root,'dist',name),manifest=fs.readFileSync(path.join(root,'dist/latest.yml'),'utf8');
    assert.ok(manifest.includes('version: '+pkg.version)&&manifest.includes(name));
    assert.equal(manifest.match(/sha512:\s*(\S+)/)[1],await digest(installer,'sha512','base64'));
    report.installerSha256=await digest(installer,'sha256','hex');report.installerBytes=fs.statSync(installer).size;
  }
  fs.mkdirSync(path.join(root,'build'),{recursive:true});
  fs.writeFileSync(path.join(root,'build','chat-package-check.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
})().catch(error=>{console.error(error);process.exit(1);});
