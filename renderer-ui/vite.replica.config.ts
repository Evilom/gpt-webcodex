import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import fs from 'node:fs';
const root=fileURLToPath(new URL('.',import.meta.url));
export default defineConfig({
  plugins:[{name:'bundled-chat-licenses',generateBundle(){
    const packages=new Map<string,string>();
    for(const id of this.getModuleIds()) {
      const normalized=id.replaceAll('\\','/'),marker=normalized.lastIndexOf('/node_modules/');
      if(marker<0)continue;
      const parts=normalized.slice(marker+14).split('/');
      const name=parts[0].startsWith('@')?parts.slice(0,2).join('/'):parts[0];
      const directory=normalized.slice(0,marker+14)+name;
      if(!packages.has(name)&&fs.existsSync(directory+'/package.json'))packages.set(name,directory);
    }
    const notices=[...packages].sort(([a],[b])=>a.localeCompare(b)).map(([name,directory])=>{
      const pkg=JSON.parse(fs.readFileSync(directory+'/package.json','utf8'));
      const licenses=fs.readdirSync(directory).filter(file=>/^(LICENSE|LICENCE|COPYING|NOTICE)(\.|$)/i.test(file)&&fs.statSync(directory+'/'+file).isFile()).map(file=>fs.readFileSync(directory+'/'+file,'utf8'));
      return `${name}@${pkg.version} (${typeof pkg.license==='string'?pkg.license:JSON.stringify(pkg.license)})\n${licenses.join('\n')}`;
    });
    const fontNotice=fs.readFileSync(resolve(root,'src/upstream/katex-fonts/NOTICE.txt'),'utf8');
    const ofl=fs.readFileSync(resolve(root,'src/upstream/katex-fonts/OFL.txt'),'utf8');
    const fontLicense=fontNotice+'\n'+ofl.slice(ofl.indexOf('-----------------------------------------------------------'));
    notices.push(fontLicense);
    this.emitFile({type:'asset',fileName:'KaTeX_FONT_LICENSE.txt',source:fontLicense});
    this.emitFile({type:'asset',fileName:'THIRD_PARTY_LICENSES.txt',source:notices.join('\n\n----------------------------------------\n\n')});
  }}],
  define:{'process.env.NODE_ENV':JSON.stringify('production')},
  build:{outDir:resolve(root,'../renderer/chat-dist'),emptyOutDir:true,sourcemap:false,minify:'esbuild',
    rollupOptions:{onwarn(warning,handler){if(warning.code==='MODULE_LEVEL_DIRECTIVE'&&warning.message.includes('use client'))return;handler(warning);}},
    lib:{entry:resolve(root,'src/chat-replica.tsx'),name:'ThinkTankChatReplica',formats:['iife'],fileName:()=> 'chat-replica.js',cssFileName:'chat-replica'},
    assetsInlineLimit:0
  }
});
