import {prepareDocumentSourceRestore} from './check-document-source-restore.mjs';
import {checkPublicationBrowser,checkPublicationRoles,checkPendingReviewBrowser} from './check-publication-browser.mjs';
import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,rm,open,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,posix} from 'node:path';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import sharp from 'sharp';
import {PDFDocument,PDFName,PDFRawStream} from 'pdf-lib';
const root=await mkdtemp(join(tmpdir(),'lanka-compose-')),project='lanka-qa-'+Date.now(),file=join(root,'compose.json');
let prepared=false;
function run(cmd,args){const r=spawnSync(cmd,args,{encoding:'utf8',maxBuffer:4*1024*1024});if(r.status!==0)throw Error(cmd+' failed: '+r.stderr);return r.stdout.trim();}
const compose=(...args)=>run('docker',['compose','-p',project,'-f',file,...args]);
try{
 run(process.execPath,['deploy/self-hosted/configure.mjs',join(root,'private')]);
 const config=JSON.parse(run('docker',['compose','-f','deploy/self-hosted/compose.yaml','--profile','operator','config','--format','json']));
 config.name=project;
 for(const item of Object.values(config.networks))delete item.name;
 for(const item of Object.values(config.volumes))delete item.name;
 for(const [name,item] of Object.entries(config.secrets))item.file=join(root,'private',name);
 for(const item of Object.values(config.services)){delete item.build;delete item.restart;}
 config.services.app.ports=[{target:4318,published:'0',host_ip:'127.0.0.1',protocol:'tcp'}];
 // A local test CA is explicitly trusted; TLS validation remains enabled.
 run('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=idp','-addext','subjectAltName=DNS:idp','-keyout',join(root,'key.pem'),'-out',join(root,'cert.pem')]);
 for(const name of ['key.pem','cert.pem'])config.secrets[name]={file:join(root,name)};
 await writeFile(join(root,'provider.mjs'),await readFile('scripts/project-mcp/fixtures/compose-oidc.mjs'));config.secrets['provider.mjs']={file:join(root,'provider.mjs')};
 config.services.idp={image:'lanka-self-hosted:local',user:'0:0',read_only:true,networks:['backend'],ports:[{target:4443,published:'0',host_ip:'127.0.0.1',protocol:'tcp'}],secrets:['key.pem','cert.pem','provider.mjs'],command:['node','/run/secrets/provider.mjs']};
 config.services.app.secrets.push({source:'cert.pem',target:'cert.pem'});config.services.app.environment={NODE_EXTRA_CA_CERTS:'/run/secrets/cert.pem',LANKA_UI_REFRESH:process.env.LANKA_UI_REFRESH==='1'?'1':'0'};
 const appConfigPath=join(root,'private/lanka.json'),appConfig=JSON.parse(await readFile(appConfigPath,'utf8'));appConfig.auth={origin:'https://lanka.example.invalid',issuer:'https://idp:4443',clientId:'qa',clientSecret:'qa-secret'};await writeFile(appConfigPath,JSON.stringify(appConfig));
 await writeFile(file,JSON.stringify(config));prepared=true;
 compose('up','-d','db','idp');compose('--profile','operator','run','--rm','migrate');compose('--profile','operator','run','--rm','grant-runtime');compose('up','-d','app');
 const publicationGrants=()=>compose('exec','-T','db','psql','-U','lanka_operator','-d','lanka','-Atc',"SELECT count(*) FROM pg_tables WHERE schemaname='lanka' AND tablename IN ('publications','publication_blobs','publication_artifacts','publication_withdrawals','publication_receipts','publication_audit') AND has_table_privilege('lanka_app',quote_ident(schemaname)||'.'||quote_ident(tablename),'SELECT') AND has_table_privilege('lanka_app',quote_ident(schemaname)||'.'||quote_ident(tablename),'INSERT') AND NOT has_table_privilege('lanka_app',quote_ident(schemaname)||'.'||quote_ident(tablename),'UPDATE') AND NOT has_table_privilege('lanka_app',quote_ident(schemaname)||'.'||quote_ident(tablename),'DELETE')");
 assert.equal(publicationGrants(),'6');
 let port=Number(compose('port','app','4318').split(':').at(-1));
 // Disposable Docker endpoints can close idle sockets; avoid pooled socket reuse without retrying uncertain writes.
 const transport=(send,options,body)=>new Promise((resolve,reject)=>{const req=send({...options,agent:false},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{const headers=new Headers();for(const [k,v] of Object.entries(res.headers))for(const value of Array.isArray(v)?v:[v])if(value!==undefined)headers.append(k,value);resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers}));});});req.on('error',error=>reject(new Error(`Transport failed: ${options.method??'GET'} ${String(options.path??'/').split('?')[0]} on port ${options.port}`,{cause:error})));req.end(body);});
 const request=(path,host='lanka.example.invalid',cookie='')=>transport(httpRequest,{hostname:'127.0.0.1',port,path,headers:{Host:host,...(cookie?{Cookie:cookie}:{})}});
 let response;for(let n=0;n<120;n++){try{response=await request('/');break;}catch{await new Promise(r=>setTimeout(r,500));}}
 if(!response){console.error('Startup containers:',compose('ps','--format','json'));console.error('Internal HTTP status:',compose('exec','-T','app','node','-e',"fetch('http://127.0.0.1:4318').then(r=>console.log(r.status))"));}
 assert.ok(response,'Application did not listen');assert.equal(response.status,200);assert.match(await response.text(),/Войти через компанию/);
 assert.equal((await request('/api/organizations')).status,401);assert.equal((await request('/','wrong.example.invalid')).status,403);
 const login=await request('/auth/login');assert.equal(login.status,302);const location=new URL(login.headers.get('location'));assert.equal(location.origin,'https://idp:4443');assert.equal(location.searchParams.get('redirect_uri'),'https://lanka.example.invalid/auth/callback');assert.equal(location.searchParams.get('code_challenge_method'),'S256');assert.match(login.headers.get('set-cookie'),/Secure/);
 const attempts=compose('exec','-T','db','psql','-U','lanka_operator','-d','lanka','-Atc','SELECT count(*) FROM lanka.browser_logins');assert.equal(attempts,'1');
 const idpPort=Number(compose('port','idp','4443').split(':').at(-1));
 // Container readiness does not guarantee the host's published TLS port is ready.
 let idpReady=false;
 for(let n=0;n<120;n++){
  try{const probe=await transport(httpsRequest,{hostname:'127.0.0.1',port:idpPort,servername:'idp',ca:await readFile(join(root,'cert.pem')),path:'/.well-known/openid-configuration',headers:{Host:'idp:4443'}});assert.equal(probe.status,200);idpReady=true;break;}
  catch(error){if(error.cause?.code!=='ECONNREFUSED')throw error;await new Promise(r=>setTimeout(r,500));}
 }
 assert.ok(idpReady,'Test identity provider published TLS port did not become ready');
 const authorize=await transport(httpsRequest,{hostname:'127.0.0.1',port:idpPort,servername:'idp',ca:await readFile(join(root,'cert.pem')),path:location.pathname+location.search,headers:{Host:'idp:4443'}});assert.equal(authorize.status,302);
 const callback=new URL(authorize.headers.get('location')),loginCookie=login.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
 const completed=await request(callback.pathname+callback.search,'lanka.example.invalid',loginCookie);assert.equal(completed.status,302);
 const sessionCookie=completed.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
 const identity=await request('/auth/session','lanka.example.invalid',sessionCookie);assert.equal(identity.status,200);const principal=(await identity.json()).principal;
 assert.equal(principal.subject,'compose-test-owner');
 const before=await request('/api/organizations','lanka.example.invalid',sessionCookie);assert.equal(before.status,200);assert.deepEqual((await before.json()).organizations,[]);
 const orgPath=join(root,'private/organization.json'),org=JSON.parse(await readFile(orgPath,'utf8'));org.ownerUserId=principal.userId;await writeFile(orgPath,JSON.stringify(org));
 compose('--profile','operator','run','--rm','provision');
 const after=await request('/api/organizations','lanka.example.invalid',sessionCookie);assert.equal(after.status,200);const organizations=(await after.json()).organizations;assert.equal(organizations.length,1);
 const page=await request('/organizations/'+organizations[0].id,'lanka.example.invalid',sessionCookie);assert.equal(page.status,200);assert.match(await page.text(),/project.js/);
 for(const path of ['/project.js','/project.css','/fonts/IBMPlexSans-Regular.ttf','/fonts/IBMPlexSans-SemiBold.ttf','/fonts/IBMPlexMono-Medium.ttf']){const asset=await request(path,'lanka.example.invalid',sessionCookie);assert.equal(asset.status,200,path);assert.ok((await asset.arrayBuffer()).byteLength>100,path);}
 assert.equal((await request('/fonts/focus3-fonts.zip')).status,401);
 const fontDownload=await request('/fonts/focus3-fonts.zip','lanka.example.invalid',sessionCookie);assert.equal(fontDownload.status,200);assert.equal(fontDownload.headers.get('content-type'),'application/zip');
 const fontBytes=Buffer.from(await fontDownload.arrayBuffer()),fontZip=await JSZip.loadAsync(fontBytes);
 const fontNames=['IBMPlexSans-Regular.ttf','IBMPlexSans-SemiBold.ttf','IBMPlexMono-Medium.ttf','OFL-IBMPlexSans.txt','OFL-IBMPlexMono.txt'];
 assert.deepEqual(Object.keys(fontZip.files).sort(),[...fontNames,'README.txt','manifest.json'].sort());
 for(const name of fontNames)assert.deepEqual(await fontZip.file(name).async('nodebuffer'),await readFile('public/fonts/'+name));
 const fontPackage={bytes:fontBytes.length,sha256:createHash('sha256').update(fontBytes).digest('hex'),filesExact:true,anonymousDenied:true};
 const tenant=organizations[0].id,docId=randomUUID();
 const post=(path,value)=>transport(httpRequest,{hostname:'127.0.0.1',port,path,method:'POST',headers:{Host:'lanka.example.invalid',Origin:'https://lanka.example.invalid',Cookie:sessionCookie,'Content-Type':'application/json'}},JSON.stringify(value));
 const created=await post('/api/organizations/'+tenant+'/library',{requestId:docId,command:{action:'create_document',title:'Письмо и города',folderId:null,profile:'focus-v3',markdown:'# Письмо и города\n\n## Города\nПоселения связывают ремесло и обмен.\n\n## Письмо\nЗаписи помогают хранить знания.'}});assert.equal(created.status,200,await created.text());
 const document=await request('/api/organizations/'+tenant+'/documents/'+docId,'lanka.example.invalid',sessionCookie);assert.equal(document.status,200);let saved=await document.json();assert.equal(saved.state.doc.design,'focus-v3');
 let pdfPages=0,pptxTextObjects=0;const exportBytes={},artifacts={};for(const format of ['pdf','pptx']){const exported=await post('/api/organizations/'+tenant+'/documents/'+docId+'/export',{deckId:saved.state.doc.id,expectedRevision:saved.state.revision,format});assert.equal(exported.status,200,format);const bytes=Buffer.from(await exported.arrayBuffer());assert.ok(bytes.length>1000);assert.ok(exported.headers.get('x-lanka-artifact'));assert.equal(bytes.subarray(0,format==='pdf'?4:2).toString(),format==='pdf'?'%PDF':'PK');exportBytes[format]=bytes.length;artifacts[format]={id:exported.headers.get('x-lanka-artifact'),sha256:createHash('sha256').update(bytes).digest('hex')};if(format==='pdf'){pdfPages=(await PDFDocument.load(bytes)).getPageCount();assert.equal(pdfPages,saved.state.doc.slides.length);}else{const zip=await JSZip.loadAsync(bytes),slides=Object.keys(zip.files).filter(p=>/^ppt\/slides\/slide\d+\.xml$/.test(p));assert.equal(slides.length,saved.state.doc.slides.length);for(const path of slides){const xml=await zip.file(path).async('string'),texts=(xml.match(/<a:t>/g)??[]).length;assert.ok(texts>0);pptxTextObjects+=texts;}}}
 // Binary attachment preservation is independent of the earlier exported revision.
 const imageBytes=await sharp({create:{width:32,height:16,channels:3,background:'#3355aa'}}).png().toBuffer();
 const uploaded=await post('/api/organizations/'+tenant+'/documents/'+docId+'/images',{requestId:randomUUID(),deckId:saved.state.doc.id,expectedRevision:saved.state.revision,slideId:saved.state.doc.slides[0].id,name:'Restore fixture.png',contentType:'image/png',base64:imageBytes.toString('base64')});assert.equal(uploaded.status,200);const attachment=await uploaded.json();
 const updated=await request('/api/organizations/'+tenant+'/documents/'+docId,'lanka.example.invalid',sessionCookie);assert.equal(updated.status,200);saved=await updated.json();assert.equal(saved.state.revision,2);
 const readAttachment=()=>request('/api/organizations/'+tenant+'/documents/'+docId+'/assets?id='+attachment.sourceId,'lanka.example.invalid',sessionCookie);
 const beforeAttachment=await readAttachment();assert.equal(beforeAttachment.status,200);assert.deepEqual(Buffer.from(await beforeAttachment.arrayBuffer()),imageBytes);
 // Export the actual edited revision; inspect image relationships, not just ZIP presence.
 const editedExportBytes={};let editedPdfImages=0,editedPptxPictures=0;
 for(const format of ['pdf','pptx']){
  const response=await post('/api/organizations/'+tenant+'/documents/'+docId+'/export',{deckId:saved.state.doc.id,expectedRevision:2,format});
  assert.equal(response.status,200,'Edited '+format);const bytes=Buffer.from(await response.arrayBuffer());
  const id=response.headers.get('x-lanka-artifact');assert.ok(id);editedExportBytes[format]=bytes.length;
  artifacts['edited-'+format]={id,sha256:createHash('sha256').update(bytes).digest('hex')};
  if(format==='pdf'){
   const pdf=await PDFDocument.load(bytes);assert.equal(pdf.getPageCount(),saved.state.doc.slides.length);
   editedPdfImages=pdf.context.enumerateIndirectObjects().filter(([,object])=>object instanceof PDFRawStream&&object.dict.get(PDFName.of('Subtype'))===PDFName.of('Image')).length;
   assert.ok(editedPdfImages>0,'Edited PDF has no embedded image');
  }else{
   const zip=await JSZip.loadAsync(bytes),slide=await zip.file('ppt/slides/slide1.xml').async('string');
   editedPptxPictures=(slide.match(/<p:pic>/g)??[]).length;assert.equal(editedPptxPictures,1,'Expected native picture on edited slide');
   assert.ok((slide.match(/<a:t>/g)??[]).length>0,'Image export rasterized the text');
   const picture=slide.match(/<p:pic>[\s\S]*?<\/p:pic>/)[0],relationshipId=picture.match(/r:embed="([^"]+)"/)[1];
   const relationships=await zip.file('ppt/slides/_rels/slide1.xml.rels').async('string');
   const relationship=relationships.match(/<Relationship\b[^>]*>/g).find(tag=>tag.includes('Id="'+relationshipId+'"'));assert.ok(relationship);
   const target=relationship.match(/Target="([^"]+)"/)[1],image=await zip.file(posix.normalize(posix.join('ppt/slides',target))).async('nodebuffer');
   const decoded=await sharp(image).removeAlpha().raw().toBuffer({resolveWithObject:true}),original=await sharp(imageBytes).removeAlpha().raw().toBuffer({resolveWithObject:true});
   assert.deepEqual(decoded.info,original.info);assert.deepEqual(decoded.data,original.data,'Exported picture differs from uploaded image');
  }
 }
 // A delegated external MCP client uses the packaged compiler, then the owner accepts.
 const documentPath='/api/organizations/'+tenant+'/documents/'+docId;
 const editable=structuredClone(saved.state.doc),targetSlide=editable.slides[1];
 targetSlide.canvas=[{id:'mcp-background',kind:'rect',x:0,y:0,w:1600,h:900,color:'#FFFFFF',locked:true},{id:'mcp-title',kind:'text',x:120,y:100,w:1000,h:100,text:targetSlide.title,size:44,bold:true,color:editable.brand.ink,font:'sans',lineHeight:1.3}];
 assert.equal((await post(documentPath,{requestId:randomUUID(),deckId:docId,expectedRevision:saved.state.revision,command:{action:'save',editorContract:'lanka-editor/3',doc:editable}})).status,200);
 saved=await(await request(documentPath,'lanka.example.invalid',sessionCookie)).json();
 const secret=randomBytes(32).toString('hex'),keyResponse=await post(documentPath+'/agent-delegations',{action:'issue',request:{requestId:randomUUID(),secret,name:'Packaged MCP QA',capability:'propose',minutes:15}});assert.equal(keyResponse.status,200);const key=await keyResponse.json();
 const mcp=async(name,args)=>{const r=await transport(httpRequest,{hostname:'127.0.0.1',port,path:'/mcp/organizations/'+tenant+'/documents/'+docId,method:'POST',headers:{Host:'lanka.example.invalid',Authorization:'Bearer '+secret,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-06-18'}},JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}}));return {status:r.status,body:await r.json()};};
 const mcpValue=r=>{assert.equal(r.status,200);assert.ok(r.body.result&&!r.body.result.isError,JSON.stringify(r.body));return JSON.parse(r.body.result.content[0].text);};
 const context=mcpValue(await mcp('lanka_get_edit_context',{}));assert.match(context.editingGuide.canvasBasicInsertion,/insert_text/);
 const insertion={requestId:randomUUID(),expectedRevision:context.revision,title:'Дополнение через MCP',commands:[{op:'insert_text',slideId:targetSlide.id,elementId:'mcp-text',value:'Письмо помогает сохранять знания.'},{op:'insert_shape',slideId:targetSlide.id,elementId:'mcp-shape'}]};
 const proposal=mcpValue(await mcp('lanka_propose_commands',insertion));assert.equal(mcpValue(await mcp('lanka_propose_commands',insertion)).proposalId,proposal.proposalId);
 const proposed=await(await request(documentPath,'lanka.example.invalid',sessionCookie)).json();assert.deepEqual(proposed.state.doc,saved.state.doc);
 const change=proposed.state.proposals.find(p=>p.id===proposal.proposalId).changes[0];assert.deepEqual(change.after.canvas.slice(0,2),targetSlide.canvas);
 const preview=mcpValue(await mcp('lanka_preview_proposal',{proposalId:proposal.proposalId}));assert.ok(preview.after.slides.some(s=>s.items.some(p=>p.kind==='text'&&p.text.includes('Письмо помогает'))));
 const pendingHome=process.env.LANKA_UI_REFRESH==='1'?await checkPendingReviewBrowser({port,cookie:sessionCookie,tenant,documentId:docId,artifacts:resolve('out/pending-home-compose')}):null;
 if(!pendingHome)assert.equal((await post(documentPath,{requestId:randomUUID(),deckId:docId,expectedRevision:context.revision,command:{action:'accept',proposalId:proposal.proposalId,changeIds:[change.id]}})).status,200);
 saved=await(await request(documentPath,'lanka.example.invalid',sessionCookie)).json();assert.deepEqual(saved.state.doc.slides[1],change.after);
 assert.equal((await post(documentPath+'/agent-delegations',{action:'revoke',id:key.id})).status,200);const revoked=await mcp('lanka_propose_commands',insertion);assert.ok([401,403].includes(revoked.status)||revoked.body.error||revoked.body.result?.isError);
 const packagedMcp={pendingHome,basicInsertion:true,proposalPreview:true,humanAcceptance:true,replayIdempotent:true,revocation:true,acceptedRevision:saved.state.revision};
 const publicationPath=documentPath+'/publications';
 const preparedResponse=await post(publicationPath,{action:'prepare',expectedRevision:saved.state.revision});assert.equal(preparedResponse.status,200,await preparedResponse.clone().text());const preparedPublication=await preparedResponse.json();
 const publicationRequest={action:'publish',requestId:randomUUID(),preparedId:preparedPublication.id,expectedHash:preparedPublication.hash,audience:'current-document-access'};
 const publicationFiles={};
 for(let page=1;page<=saved.state.doc.slides.length;page++){
  const response=await request(publicationPath+'/'+preparedPublication.id+'/artifacts?kind=preview&page='+page+'&prepared=true','lanka.example.invalid',sessionCookie);assert.equal(response.status,200);const bytes=Buffer.from(await response.arrayBuffer());assert.equal(bytes.subarray(1,4).toString(),'PNG');await mkdir('out/publication-previews',{recursive:true});await writeFile('out/publication-previews/page-'+page+'.png',bytes);
 }
 const publicationResponse=await post(publicationPath,publicationRequest);assert.equal(publicationResponse.status,200);const published=await publicationResponse.json();assert.equal(published.withdrawn,false);
 assert.deepEqual(await(await post(publicationPath,publicationRequest)).json(),published);
 const publishedSnapshot=await(await request(publicationPath+'/'+published.id,'lanka.example.invalid',sessionCookie)).json();
 for(const kind of ['pdf','pptx']){
  const response=await request(publicationPath+'/'+published.id+'/artifacts?kind='+kind,'lanka.example.invalid',sessionCookie);assert.equal(response.status,200);const bytes=Buffer.from(await response.arrayBuffer());publicationFiles[kind]=createHash('sha256').update(bytes).digest('hex');
  if(kind==='pdf')assert.equal((await PDFDocument.load(bytes)).getPageCount(),saved.state.doc.slides.length);
  else {const zip=await JSZip.loadAsync(bytes);assert.match(await zip.file('ppt/slides/slide1.xml').async('string'),/<p:pic>/);assert.match(await zip.file('ppt/slides/slide2.xml').async('string'),/<a:t>/);}
 }
 const dependencyResponse=await request(publicationPath+'/'+published.id+'/artifacts?kind=dependencies','lanka.example.invalid',sessionCookie);assert.equal(dependencyResponse.status,200);assert.equal(dependencyResponse.headers.get('content-type'),'application/zip');
 const dependencyBytes=Buffer.from(await dependencyResponse.arrayBuffer());publicationFiles.dependencies=createHash('sha256').update(dependencyBytes).digest('hex');
 const dependencyZip=await JSZip.loadAsync(dependencyBytes),dependencyManifest=JSON.parse(await dependencyZip.file('manifest.json').async('string'));
 assert.equal(dependencyManifest.publicationId,published.id);assert.equal(dependencyManifest.payloadHash,published.hash);assert.equal(dependencyManifest.sourceRevision,4);
 for(const f of dependencyManifest.files){const bytes=await dependencyZip.file(f.path).async('nodebuffer');assert.equal(createHash('sha256').update(bytes).digest('hex'),f.sha256);assert.deepEqual(bytes,await readFile('public/fonts/'+f.path.split('/').at(-1)));}
 for(const kind of ['pdf','pptx'])assert.equal(dependencyManifest.artifacts.find(a=>a.kind===kind).sha256,publicationFiles[kind]);
 assert.equal(publishedSnapshot.hasDependencies,true);
 const later=structuredClone(saved.state.doc);later.slides[1].notes='PRIVATE_NOTE_AFTER_PUBLICATION';
 assert.equal((await post(documentPath,{requestId:randomUUID(),deckId:docId,expectedRevision:saved.state.revision,command:{action:'save',editorContract:'lanka-editor/3',doc:later}})).status,200);
 saved=await(await request(documentPath,'lanka.example.invalid',sessionCookie)).json();
 assert.deepEqual(await(await request(publicationPath+'/'+published.id,'lanka.example.invalid',sessionCookie)).json(),publishedSnapshot);
 const publicationCopyRequest={requestId:randomUUID(),publicationId:published.id,expectedRevision:publishedSnapshot.origin.revision,title:'Копия опубликованных городов',folderId:null};
 const publicationCopyResponse=await post(documentPath+'/copy',publicationCopyRequest);assert.equal(publicationCopyResponse.status,200,await publicationCopyResponse.clone().text());const publicationCopy=await publicationCopyResponse.json();
 assert.deepEqual(await(await post(documentPath+'/copy',publicationCopyRequest)).json(),publicationCopy);
 const publicationCopyPath='/api/organizations/'+tenant+'/documents/'+publicationCopy.id;
 const publicationCopySnapshot=await(await request(publicationCopyPath,'lanka.example.invalid',sessionCookie)).json();
 assert.equal(publicationCopySnapshot.state.revision,1);assert.equal(JSON.stringify(publicationCopySnapshot).includes('PRIVATE_NOTE_AFTER_PUBLICATION'),false);
 const copiedImage=publicationCopySnapshot.state.sources.find(s=>s.kind==='image');assert.ok(copiedImage);assert.equal(copiedImage.sha256,createHash('sha256').update(imageBytes).digest('hex'));
 const copiedImageResponse=await request(publicationCopyPath+'/assets?id='+copiedImage.id,'lanka.example.invalid',sessionCookie);assert.equal(copiedImageResponse.status,200);assert.deepEqual(Buffer.from(await copiedImageResponse.arrayBuffer()),imageBytes);
 const copyEdit=structuredClone(publicationCopySnapshot.state.doc);const copyText=copyEdit.slides[1].canvas.find(e=>e.kind==='text');assert.ok(copyText);copyText.text='Текст редактируется в копии';
 assert.equal((await post(publicationCopyPath,{requestId:randomUUID(),deckId:copyEdit.id,expectedRevision:1,command:{action:'save',editorContract:'lanka-editor/3',doc:copyEdit}})).status,200);
 const editedPublicationCopy=await(await request(publicationCopyPath,'lanka.example.invalid',sessionCookie)).json();assert.equal(editedPublicationCopy.state.revision,2);assert.deepEqual(editedPublicationCopy.state.doc,copyEdit);
 assert.deepEqual(await(await request(publicationPath+'/'+published.id,'lanka.example.invalid',sessionCookie)).json(),publishedSnapshot);
 const publicationAgentSecret=randomBytes(32).toString('hex'),workspaceKeys='/api/organizations/'+tenant+'/agent-delegations';
 const publicationKeyResponse=await post(workspaceKeys,{action:'issue',request:{requestId:randomUUID(),secret:publicationAgentSecret,name:'Publication MCP QA',capability:'create',minutes:15}});assert.equal(publicationKeyResponse.status,200);const publicationKey=await publicationKeyResponse.json();
 const publicationRpc=async(method,params)=>{const response=await transport(httpRequest,{hostname:'127.0.0.1',port,path:'/mcp/organizations/'+tenant,method:'POST',headers:{Host:'lanka.example.invalid',Authorization:'Bearer '+publicationAgentSecret,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-06-18'}},JSON.stringify({jsonrpc:'2.0',id:1,method,params}));return {status:response.status,body:await response.json()};};
 const publicationTool=(name,args={})=>publicationRpc('tools/call',{name,arguments:args});
 const publicationTools=(await publicationRpc('tools/list',{})).body.result.tools;assert.ok(publicationTools.find(t=>t.name==='lanka_copy_shared_document').inputSchema.properties.publicationId);
 const publicationList=mcpValue(await publicationTool('lanka_list_publications',{documentId:docId}));assert.equal(publicationList.items[0].id,published.id);assert.equal(publicationList.nextCursor,null);
 const publicationCatalogPath='/api/organizations/'+tenant+'/publication-catalog';
 const publicationCatalogResponse=await request(publicationCatalogPath,'lanka.example.invalid',sessionCookie);assert.equal(publicationCatalogResponse.status,200);assert.equal(publicationCatalogResponse.headers.get('cache-control'),'no-store');
 const publicationCatalog=await publicationCatalogResponse.json();assert.equal(publicationCatalog.items.length,1);assert.equal(publicationCatalog.items[0].id,published.id);assert.equal(publicationCatalog.items[0].documentId,docId);
 const agentCatalog=mcpValue(await publicationTool('lanka_search_publications'));assert.ok(agentCatalog.items.every(item=>!Object.hasOwn(item,'reactions')));assert.deepEqual(agentCatalog,{...publicationCatalog,items:publicationCatalog.items.map(({reactions,...item})=>item)});
 assert.deepEqual(mcpValue(await publicationTool('lanka_search_publications',{search:'no-matching-publication'})).items,[]);
 const publicationBrowser=await checkPublicationBrowser({port,cookie:sessionCookie,tenant,documentId:docId,publicationId:published.id,revision:4,artifacts:resolve('out/publication-browser-compose'),hideCopyImage:async(id,h)=>{
  assert.match(id,/^[a-f0-9-]{36}$/);assert.match(h,/^[a-f0-9]{64}$/);
  compose('exec','-T','db','psql','-U','lanka_operator','-d','lanka','-Atc',`DELETE FROM lanka.blobs WHERE tenant_id='${tenant}' AND material_id='${id}' AND key='materials/${h}.bin'`);
 }});

 const publicationRead=mcpValue(await publicationTool('lanka_get_publication',{documentId:docId,publicationId:published.id}));assert.equal(publicationRead.origin.revision,4);assert.equal(JSON.stringify(publicationRead).includes('PRIVATE_NOTE_AFTER_PUBLICATION'),false);
 const publicationPng=await publicationTool('lanka_preview_publication',{documentId:docId,publicationId:published.id,page:1});assert.equal(publicationPng.body.result.content[1].type,'image');assert.equal(publicationPng.body.result.content[1].mimeType,'image/png');
 const agentCopyRequest={...publicationCopyRequest,requestId:randomUUID(),sourceDocumentId:docId,title:'Копия публикации через MCP'};
 const agentCopy=mcpValue(await publicationTool('lanka_copy_shared_document',agentCopyRequest));assert.equal(agentCopy.sourcePublicationId,published.id);assert.deepEqual(mcpValue(await publicationTool('lanka_copy_shared_document',agentCopyRequest)),agentCopy);
 const forbiddenPublish=await publicationTool('lanka_publish_publication',{documentId:docId});assert.ok(forbiddenPublish.body.error);
 assert.equal((await post(workspaceKeys,{action:'revoke',id:publicationKey.id})).status,200);assert.ok([401,403].includes((await publicationTool('lanka_list_publications',{documentId:docId})).status));
 const pendingPublication=await(await post(publicationPath,{action:'prepare',expectedRevision:saved.state.revision})).json();assert.ok(pendingPublication.id);
 const publicationAcceptance={prepare:true,previewPages:saved.state.doc.slides.length,activate:true,idempotent:true,nativePptx:true,pinnedAfterEdit:true,sourceRevision:publishedSnapshot.origin.revision};
 const conversationId=randomUUID(),conversationPath='/api/organizations/'+tenant+'/conversations/'+conversationId;
 assert.equal((await post('/api/organizations/'+tenant+'/conversations',{requestId:conversationId,title:'Обсуждение городов'})).status,200);
 assert.equal((await post(conversationPath,{action:'link',documentId:docId})).status,200);
 const cancelledId=randomUUID(),pending={action:'send',requestId:randomUUID(),text:'Уточни формулировку о письме',task:{mode:'propose',documentId:docId}};
 assert.equal((await post(conversationPath,{action:'send',requestId:cancelledId,text:'Добавь ещё один слайд'})).status,200);
 assert.equal((await post(conversationPath,{action:'cancel',messageId:cancelledId})).status,200);
 assert.equal((await post(conversationPath,pending)).status,200);
 const readConversation=async()=>{const response=await request(conversationPath,'lanka.example.invalid',sessionCookie);assert.equal(response.status,200);return response.json();};
 const conversationBefore=await readConversation();assert.equal(conversationBefore.messages.length,2);assert.equal(conversationBefore.messages[0].delivery,'cancelled');assert.equal(conversationBefore.messages[1].delivery,'waiting');assert.equal(conversationBefore.documents[0].id,docId);
 // Same verified email does not confer another identity's organization membership.
 const otherLogin=await request('/auth/login');assert.equal(otherLogin.status,302);const otherLocation=new URL(otherLogin.headers.get('location'));otherLocation.searchParams.set('test_user','other');
 const otherAuthorize=await transport(httpsRequest,{hostname:'127.0.0.1',port:idpPort,servername:'idp',ca:await readFile(join(root,'cert.pem')),path:otherLocation.pathname+otherLocation.search,headers:{Host:'idp:4443'}});assert.equal(otherAuthorize.status,302);
 const otherCallback=new URL(otherAuthorize.headers.get('location'));const otherDone=await request(otherCallback.pathname+otherCallback.search,'lanka.example.invalid',otherLogin.headers.getSetCookie().map(v=>v.split(';')[0]).join('; '));assert.equal(otherDone.status,302);
 const otherCookie=otherDone.headers.getSetCookie().map(v=>v.split(';')[0]).join('; '),otherSession=await request('/auth/session','lanka.example.invalid',otherCookie);assert.equal(otherSession.status,200);const otherPrincipal=(await otherSession.json()).principal;assert.notEqual(otherPrincipal.userId,principal.userId);
 const otherEmpty=await request('/api/organizations','lanka.example.invalid',otherCookie);assert.deepEqual((await otherEmpty.json()).organizations,[]);
 const otherOrg={requestId:randomUUID(),slug:'other-company',name:'Other QA company',ownerUserId:otherPrincipal.userId};await writeFile(orgPath,JSON.stringify(otherOrg));compose('--profile','operator','run','--rm','provision');
 const membershipPath='/api/organizations/'+tenant+'/members';
 assert.equal((await post(membershipPath,{requestId:randomUUID(),userId:otherPrincipal.userId,role:'member',status:'active'})).status,200);
 const readerPrincipalId=compose('exec','-T','db','psql','-U','lanka_operator','-d','lanka','-Atc',`SELECT id FROM lanka.principals WHERE tenant_id='${tenant}' AND user_id='${otherPrincipal.userId}'`);
 const shareView=await(await request(documentPath+'/sharing','lanka.example.invalid',sessionCookie)).json();
 assert.equal((await post(documentPath+'/sharing',{requestId:randomUUID(),expectedEpoch:shareView.authzEpoch,subject:{kind:'principal',id:readerPrincipalId},role:'viewer',canCopy:true})).status,200);
 const publicationRoles=await checkPublicationRoles({port,ownerCookie:sessionCookie,readerCookie:otherCookie,tenant,documentId:docId,revision:5,artifacts:resolve('out/publication-roles-compose'),
  hideCurrentImage:async()=>{const h=createHash('sha256').update(imageBytes).digest('hex');compose('exec','-T','db','psql','-U','lanka_operator','-d','lanka','-Atc',`DELETE FROM lanka.blobs WHERE tenant_id='${tenant}' AND material_id='${docId}' AND key='materials/${h}.bin'`);},
  restoreCurrentImage:async()=>{const h=createHash('sha256').update(imageBytes).digest('hex');compose('exec','-T','db','psql','-U','lanka_operator','-d','lanka','-Atc',`INSERT INTO lanka.blobs(tenant_id,material_id,key,bytes) SELECT tenant_id,material_id,'materials/'||hash||'.bin',bytes FROM lanka.revision_dependency_blobs WHERE tenant_id='${tenant}' AND material_id='${docId}' AND hash='${h}' ON CONFLICT DO NOTHING`);}
});
 const reviewPath=documentPath+'/review-requests';
 const reviewSharing=await(await request(documentPath+'/sharing','lanka.example.invalid',sessionCookie)).json();
 assert.equal((await post(documentPath+'/sharing',{requestId:randomUUID(),expectedEpoch:reviewSharing.authzEpoch,subject:{kind:'principal',id:readerPrincipalId},role:'commenter',canCopy:false})).status,200);
 const reviewList=await(await request(reviewPath,'lanka.example.invalid',sessionCookie)).json();assert.ok(reviewList.target);
 const reviewCommand={action:'create',requestId:randomUUID(),recipientId:readerPrincipalId,target:reviewList.target,note:'Проверка резервного восстановления'};
 const reviewCreated=await post(reviewPath,reviewCommand);assert.equal(reviewCreated.status,200);const reviewPending=await reviewCreated.json();
 const secondReview=await post(reviewPath,{...reviewCommand,requestId:randomUUID(),note:'Завершённая проверка'});assert.equal(secondReview.status,200);const reviewAnswered=await secondReview.json();
 const readerPost=(path,value)=>transport(httpRequest,{hostname:'127.0.0.1',port,path,method:'POST',headers:{Host:'lanka.example.invalid',Origin:'https://lanka.example.invalid',Cookie:otherCookie,'Content-Type':'application/json'}},JSON.stringify(value));
 const reviewReply={action:'respond',requestId:randomUUID(),id:reviewAnswered.id,expectedStatusVersion:1,target:reviewAnswered.target,outcome:'reviewed',note:'Проверено до backup'};
 const reviewReplyResponse=await readerPost(reviewPath,reviewReply);assert.equal(reviewReplyResponse.status,200);const reviewReplyReceipt=await reviewReplyResponse.json();
 const reviewAgentSecret=randomBytes(32).toString('hex');assert.equal((await post(documentPath+'/agent-delegations',{action:'issue',request:{requestId:randomUUID(),secret:reviewAgentSecret,name:'Review context QA',capability:'read',minutes:15}})).status,200);
 const reviewMcp=async()=>{const r=await transport(httpRequest,{hostname:'127.0.0.1',port,path:'/mcp/organizations/'+tenant+'/documents/'+docId,method:'POST',headers:{Host:'lanka.example.invalid',Authorization:'Bearer '+reviewAgentSecret,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-06-18'}},JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'lanka_get_colleague_review',arguments:{reviewId:reviewAnswered.id}}}));return {status:r.status,body:await r.json()};};
 const reviewAgentBefore=await reviewMcp();assert.equal(reviewAgentBefore.status,200);assert.ok(!reviewAgentBefore.body.result.isError);const reviewFeedback=JSON.parse(reviewAgentBefore.body.result.content[0].text);assert.equal(reviewFeedback.review.response.note,reviewReply.note);
 const inboxPath='/api/organizations/'+tenant+'/review-inbox';
 const inboxBefore=await(await request(inboxPath,'lanka.example.invalid',otherCookie)).json();assert.deepEqual(inboxBefore.items.map(r=>r.id),[reviewPending.id]);assert.equal(inboxBefore.items[0].documentId,docId);
 assert.deepEqual((await(await request(inboxPath,'lanka.example.invalid',sessionCookie)).json()).items,[]);
 assert.deepEqual((await(await request('/api/organizations/'+otherOrg.requestId+'/review-inbox','lanka.example.invalid',otherCookie)).json()).items,[]);
 const reviewVersion=await(await request(reviewPath+'/'+reviewPending.id+'/version','lanka.example.invalid',otherCookie)).json();assert.ok(reviewVersion.version);
 const reviewImage=reviewVersion.version.sources.find(source=>source.kind==='image');assert.ok(reviewImage);
 const reviewImagePath=reviewPath+'/'+reviewPending.id+'/assets?id='+encodeURIComponent(reviewImage.id),reviewImageResponse=await request(reviewImagePath,'lanka.example.invalid',otherCookie);assert.equal(reviewImageResponse.status,200);
 const reviewImageHash=createHash('sha256').update(Buffer.from(await reviewImageResponse.arrayBuffer())).digest('hex');
 const reviewRows=()=>compose('exec','-T','db','psql','-U','lanka_operator','-d','lanka','-Atc',`SELECT md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]'::jsonb)::text) FROM lanka.colleague_reviews r WHERE tenant_id='${tenant}'`);
 const reviewReceipts=()=>compose('exec','-T','db','psql','-U','lanka_operator','-d','lanka','-Atc',`SELECT md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY actor_id,request_id),'[]'::jsonb)::text) FROM lanka.colleague_review_receipts r WHERE tenant_id='${tenant}'`);
 const reviewRowsBefore=reviewRows(),reviewReceiptsBefore=reviewReceipts();
 assert.equal((await post(membershipPath,{requestId:randomUUID(),userId:otherPrincipal.userId,role:'member',status:'suspended'})).status,200);
 const assertIsolation=async()=>{
  const listing=await request('/api/organizations','lanka.example.invalid',otherCookie);assert.equal(listing.status,200);const entries=(await listing.json()).organizations;assert.equal(entries.length,1);assert.equal(entries[0].id,otherOrg.requestId);
  for(const path of [inboxPath,'/api/organizations/'+tenant+'/library','/api/organizations/'+tenant+'/documents/'+docId,'/api/organizations/'+tenant+'/documents/'+docId+'/assets?id='+attachment.sourceId,conversationPath]){const denied=await request(path,'lanka.example.invalid',otherCookie);assert.ok([403,404].includes(denied.status),path+' status '+denied.status);}
  const opposite=await request('/api/organizations/'+otherOrg.requestId+'/library','lanka.example.invalid',sessionCookie);assert.ok([403,404].includes(opposite.status));
 };
 await assertIsolation();
 const documentSourceRestore=await prepareDocumentSourceRestore({tenant,post,get:path=>request(path,'lanka.example.invalid',sessionCookie),rpc:async(documentId,token,name,args)=>{const r=await transport(httpRequest,{hostname:'127.0.0.1',port,path:'/mcp/organizations/'+tenant+'/documents/'+documentId,method:'POST',headers:{Host:'lanka.example.invalid',Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-06-18'}},JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}}));return {status:r.status,body:await r.json()};}});
 const sourceGrantSnapshot=()=>compose('exec','-T','db','psql','-U','lanka_operator','-d','lanka','-Atc',"SELECT count(*)||':'||md5(jsonb_agg(to_jsonb(g) ORDER BY delegation_id,source_id)::text) FROM lanka.document_source_grants g");
 const sourceGrantsBefore=sourceGrantSnapshot();assert.match(sourceGrantsBefore,/^2:/);
 // Restore into freshly initialized volumes belonging only to this disposable QA project.
 const recoveryStarted=performance.now();
 compose('stop','app');
 const revisionArchiveState=()=>compose('exec','-T','db','psql','-U','lanka_operator','-d','lanka','-Atc',`SELECT encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(s) ORDER BY revision),'[]'::jsonb)::text,'UTF8')),'hex') FROM lanka.revision_dependency_snapshots s WHERE tenant_id='${tenant}' AND material_id='${docId}'`);
 const archivedRevisions=compose('exec','-T','db','psql','-U','lanka_operator','-d','lanka','-Atc',`SELECT count(*) FROM lanka.revision_dependency_snapshots WHERE tenant_id='${tenant}' AND material_id='${docId}'`);assert.equal(archivedRevisions,'5');
 const revisionArchiveBefore=revisionArchiveState(),archivedImageHash=createHash('sha256').update(imageBytes).digest('hex');
 const archiveImage=()=>compose('exec','-T','db','psql','-U','lanka_operator','-d','lanka','-Atc',`SELECT encode(sha256(bytes),'hex') FROM lanka.revision_dependency_blobs WHERE tenant_id='${tenant}' AND material_id='${docId}' AND hash='${archivedImageHash}'`);assert.equal(archiveImage(),archivedImageHash);
 const revisionGrants=()=>compose('exec','-T','db','psql','-U','lanka_operator','-d','lanka','-Atc',"SELECT count(*) FROM pg_tables WHERE schemaname='lanka' AND tablename IN ('revision_dependency_snapshots','revision_dependency_blobs') AND has_table_privilege('lanka_app',quote_ident(schemaname)||'.'||quote_ident(tablename),'SELECT') AND has_table_privilege('lanka_app',quote_ident(schemaname)||'.'||quote_ident(tablename),'INSERT') AND NOT has_table_privilege('lanka_app',quote_ident(schemaname)||'.'||quote_ident(tablename),'UPDATE') AND NOT has_table_privilege('lanka_app',quote_ident(schemaname)||'.'||quote_ident(tablename),'DELETE')");assert.equal(revisionGrants(),'2');
 const dumpStarted=performance.now();
 const dumpPath=join(root,'database.dump'),dumpFile=await open(dumpPath,'wx',0o600);
 try{const dump=spawnSync('docker',['compose','-p',project,'-f',file,'exec','-T','db','pg_dump','-U','lanka_operator','-d','lanka','-Fc','--no-owner','--no-acl'],{stdio:['ignore',dumpFile.fd,'pipe']});assert.equal(dump.status,0,dump.stderr?.toString());}finally{await dumpFile.close();}
 const dumpMs=Math.round(performance.now()-dumpStarted),dumpBytes=(await stat(dumpPath)).size;assert.ok(dumpBytes>0);
 compose('rm','-s','-f','app','db');
 for(const suffix of ['database','runtime']){const volume=project+'_'+suffix;const label=run('docker',['volume','inspect',volume,'--format','{{index .Labels "com.docker.compose.project"}}']);assert.equal(label,project);run('docker',['volume','rm',volume]);}
 compose('up','-d','db');
 // The image's temporary initialization server accepts local sockets before its final restart.
 // Wait for TCP so pg_restore cannot race that temporary server's shutdown.
 let restoreReady=false;for(let n=0;n<40;n++){const ready=spawnSync('docker',['compose','-p',project,'-f',file,'exec','-T','db','pg_isready','-h','127.0.0.1','-U','lanka_operator','-d','lanka'],{stdio:'ignore'});if(ready.status===0){restoreReady=true;break;}await new Promise(r=>setTimeout(r,500));}assert.ok(restoreReady,'Database did not become ready for restore');
 const restoreStarted=performance.now();
 const dumpInput=await open(dumpPath,'r');try{const restored=spawnSync('docker',['compose','-p',project,'-f',file,'exec','-T','db','pg_restore','-U','lanka_operator','-d','lanka','--no-owner','--no-acl','--exit-on-error'],{stdio:[dumpInput.fd,'ignore','pipe']});assert.equal(restored.status,0,restored.stderr?.toString());}finally{await dumpInput.close();}
 const restoreDatabaseMs=Math.round(performance.now()-restoreStarted);
 compose('--profile','operator','run','--rm','grant-runtime');compose('up','-d','app');port=Number(compose('port','app','4318').split(':').at(-1));
 let recovered;for(let n=0;n<40;n++){try{recovered=await request('/api/organizations/'+tenant+'/documents/'+docId,'lanka.example.invalid',sessionCookie);break;}catch{await new Promise(r=>setTimeout(r,500));}}
 assert.ok(recovered);assert.equal(recovered.status,200);assert.deepEqual(await recovered.json(),saved);
 const documentAvailableMs=Math.round(performance.now()-recoveryStarted);
 assert.equal(publicationGrants(),'6');assert.equal(revisionGrants(),'2');assert.equal(revisionArchiveState(),revisionArchiveBefore);assert.equal(archiveImage(),archivedImageHash);
 assert.equal(sourceGrantSnapshot(),sourceGrantsBefore);
 const documentSourceRecovery={...(await documentSourceRestore.check()),grantRows:2,grantRowsRestoredExact:true,freshVolumeRestore:true};
 const deniedRestoredSources=await request('/api/organizations/'+tenant+'/documents/'+documentSourceRestore.documentId+'/agent-delegations?sourcePreview=1','lanka.example.invalid',otherCookie);assert.ok([403,404].includes(deniedRestoredSources.status));documentSourceRecovery.otherOrganizationDenied=true;
 assert.equal(reviewRows(),reviewRowsBefore);assert.equal(reviewReceipts(),reviewReceiptsBefore);assert.ok([403,404].includes((await request(reviewImagePath,'lanka.example.invalid',otherCookie)).status));
 const colleagueReviewAcceptance={pendingAndAnsweredRestoredExact:true,receiptsRestoredExact:true,revokedReaderDeniedAfterRestore:true,archivedImageBeforeBackup:reviewImageHash};
 const restoredRevoked=await mcp('lanka_get_edit_context',{});assert.ok([401,403].includes(restoredRevoked.status)||restoredRevoked.body.error||restoredRevoked.body.result?.isError);packagedMcp.revocationAfterRestore=true;
 for(const artifact of Object.values(artifacts)){const restored=await request('/api/organizations/'+tenant+'/documents/'+docId+'/exports?artifactId='+artifact.id+'&part=file','lanka.example.invalid',sessionCookie);assert.equal(restored.status,200);assert.equal(createHash('sha256').update(Buffer.from(await restored.arrayBuffer())).digest('hex'),artifact.sha256);}
 assert.deepEqual(await(await request(publicationPath+'/'+published.id,'lanka.example.invalid',sessionCookie)).json(),publishedSnapshot);
 for(const [kind,expectedHash] of Object.entries(publicationFiles)){const response=await request(publicationPath+'/'+published.id+'/artifacts?kind='+kind,'lanka.example.invalid',sessionCookie);assert.equal(response.status,200);assert.equal(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'),expectedHash);}
 assert.equal((await post(publicationPath,{...publicationRequest,requestId:randomUUID(),preparedId:pendingPublication.id,expectedHash:pendingPublication.hash})).status,409);
 const withdrawal={action:'withdraw',requestId:randomUUID()};assert.equal((await post(publicationPath+'/'+published.id,withdrawal)).status,200);
 assert.equal((await(await post(publicationPath,publicationRequest)).json()).withdrawn,true);
 assert.equal((await request(publicationPath+'/'+published.id+'/artifacts?kind=pdf','lanka.example.invalid',sessionCookie)).status,404);
 assert.deepEqual((await(await request(publicationPath,'lanka.example.invalid',sessionCookie)).json()).items,[]);
 assert.deepEqual(await(await request(publicationCopyPath,'lanka.example.invalid',sessionCookie)).json(),editedPublicationCopy);
 assert.equal((await post(documentPath+'/copy',publicationCopyRequest)).status,404);
 assert.ok([401,403].includes((await publicationTool('lanka_list_publications',{documentId:docId})).status));
 assert.ok([401,403].includes((await publicationTool('lanka_search_publications')).status));
 Object.assign(publicationAcceptance,{mcpDiscovery:true,mcpReadFrozen:true,mcpPng:true,mcpCopy:true,mcpRevocationAfterRestore:true,copyPinnedVersion:true,copyImageExact:true,copyEditable:true,copyRestoredExact:true,copyReplayAfterWithdrawalDenied:true,restoredSnapshotExact:true,restoredFilesExact:true,restartRequiresNewPreview:true,withdrawal:true,replayCannotReactivate:true});
 const recoveredAttachment=await readAttachment();assert.equal(recoveredAttachment.status,200);assert.deepEqual(Buffer.from(await recoveredAttachment.arrayBuffer()),imageBytes);
 assert.deepEqual(await readConversation(),conversationBefore);
 assert.equal((await post(conversationPath,pending)).status,200);assert.deepEqual(await readConversation(),conversationBefore);
 assert.equal((await post(conversationPath,{action:'cancel',messageId:pending.requestId})).status,200);const conversationAfter=await readConversation();assert.equal(conversationAfter.messages.length,2);assert.equal(conversationAfter.messages[1].delivery,'cancelled');
 await assertIsolation();
 assert.equal((await post(membershipPath,{requestId:randomUUID(),userId:otherPrincipal.userId,role:'member',status:'active'})).status,200);
 const restoredReviewAgent=await reviewMcp();assert.equal(restoredReviewAgent.status,200);assert.deepEqual(JSON.parse(restoredReviewAgent.body.result.content[0].text),reviewFeedback);
 const restoredInbox=await request(inboxPath,'lanka.example.invalid',otherCookie);assert.equal(restoredInbox.status,200);assert.deepEqual((await restoredInbox.json()).items,inboxBefore.items);
 const restoredReviewVersion=await request(reviewPath+'/'+reviewPending.id+'/version','lanka.example.invalid',otherCookie);assert.equal(restoredReviewVersion.status,200);assert.deepEqual(await restoredReviewVersion.json(),reviewVersion);
 const restoredReviewImage=await request(reviewImagePath,'lanka.example.invalid',otherCookie);assert.equal(restoredReviewImage.status,200);assert.equal(createHash('sha256').update(Buffer.from(await restoredReviewImage.arrayBuffer())).digest('hex'),reviewImageHash);
 const replayedReview=await post(reviewPath,reviewCommand);assert.equal(replayedReview.status,200);assert.deepEqual(await replayedReview.json(),reviewPending);
 const replayedReviewReply=await readerPost(reviewPath,reviewReply);assert.equal(replayedReviewReply.status,200);assert.deepEqual(await replayedReviewReply.json(),reviewReplyReceipt);
 assert.equal(reviewRows(),reviewRowsBefore);assert.equal(reviewReceipts(),reviewReceiptsBefore);
 assert.equal((await post(membershipPath,{requestId:randomUUID(),userId:otherPrincipal.userId,role:'member',status:'suspended'})).status,200);await assertIsolation();
 const deniedReviewAgent=await reviewMcp();assert.ok(deniedReviewAgent.status>=400||deniedReviewAgent.body.result?.isError||deniedReviewAgent.body.error);
 Object.assign(colleagueReviewAcceptance,{mcpFeedbackRestoredExact:true,mcpParticipantRevocationDenied:true,inboxRestoredExact:true,inboxRecipientOnly:true,inboxOtherOrganizationEmpty:true,inboxRevocationDenied:true,versionRestoredExact:true,imageRestoredExact:true,createAndResponseReplayExact:true,replaysDoNotAddRows:true,isolationAfterReactivationAndRevocation:true});
 const recovery={dumpBytes,dumpMs,restoreDatabaseMs,documentAvailableMs,allChecksMs:Math.round(performance.now()-recoveryStarted),scope:'Disposable two-organization fixture; not a production SLA'};
 const health=()=>spawnSync('docker',['compose','-p',project,'-f',file,'exec','-T','app','node','.project-runtime/check-self-hosted-health.mjs','--config','/run/secrets/lanka.json'],{encoding:'utf8'});
 assert.equal(health().status,0,'Ready server failed health check');
 compose('stop','db');const unavailable=health();assert.equal(unavailable.status,1,'Unavailable database reported healthy');assert.equal((unavailable.stdout+unavailable.stderr).trim(),'');
 compose('up','-d','db');let recoveredHealth=false;for(let n=0;n<30;n++){if(health().status===0){recoveredHealth=true;break;}await new Promise(r=>setTimeout(r,500));}assert.ok(recoveredHealth,'Health did not recover after database restart');
 // An in-flight request must finish before the container's stop deadline.
 const drainingPayload=JSON.stringify({action:'send',requestId:randomUUID(),text:'Сообщение при остановке'});
 let drainingRequest;const drainingResponse=new Promise(resolve=>{drainingRequest=httpRequest({hostname:'127.0.0.1',port,path:conversationPath,method:'POST',headers:{Host:'lanka.example.invalid',Origin:'https://lanka.example.invalid',Cookie:sessionCookie,'Content-Type':'application/json','Content-Length':Buffer.byteLength(drainingPayload)}},res=>{res.resume();res.on('end',()=>resolve({status:res.statusCode}));});drainingRequest.on('error',()=>resolve({status:0}));drainingRequest.write(drainingPayload.slice(0,10));});
 await new Promise(r=>setTimeout(r,500));
 const stopping=spawn('docker',['compose','-p',project,'-f',file,'stop','app'],{stdio:'ignore'}),stopped=new Promise(resolve=>stopping.once('close',resolve));
 await new Promise(r=>setTimeout(r,12_000));drainingRequest.end(drainingPayload.slice(10));
 const drained=await drainingResponse;await stopped;
 const stoppedContainer=compose('ps','-a','-q','app'),exitCode=Number(run('docker',['inspect',stoppedContainer,'--format','{{.State.ExitCode}}']));
 assert.equal(drained.status,200,'In-flight request was interrupted during shutdown (container exit '+exitCode+')');assert.equal(exitCode,0,'Application was killed instead of draining');
 const result={colleagueReviewAcceptance,uiRefresh:process.env.LANKA_UI_REFRESH==='1',documentSourceRecovery,checkedAt:new Date().toISOString(),compose:true,image:'lanka-self-hosted:local',recovery,imageId:run('docker',['image','inspect','lanka-self-hosted:local','--format','{{.Id}}']),fontPackage,packagedMcp,publicationAcceptance,publicationBrowser,publicationRoles,revisionDependenciesCaptured:true,revisionDependenciesRestored:true,revisionDependencyGrants:true,publicationDependencyBundle:true,publicationDependencyHashes:true,publicationDependencyRestored:true,publicationAppendOnlyGrants:true,publicationGrantsAfterRestore:true,isolatedProject:true,migrate:true,runtimeGrant:true,tlsDiscovery:true,loginPage:true,anonymousApiDenied:true,wrongHostDenied:true,pkceRedirect:true,loginStatePersisted:true,testOidcCallback:true,identityPersisted:true,noImplicitMembership:true,organizationProvisioned:true,editorAssets:true,focus3Created:true,exportBytes,pdfPages,pptxTextObjects,editedRevision:2,editedExportBytes,editedPdfImages,editedPptxPictures,editedPptxImagePixelsExact:true,restoredEditedExportHashes:true,freshVolumeRestore:true,restoredDocumentExact:true,restoredExportHashes:true,restoredConversationExact:true,restoredSendIdempotent:true,restoredCancellation:true,restoredImageExact:true,gracefulStopAfter12Seconds:true,twoOrganizationIsolation:true,isolationAfterRestore:true,healthDetectsDatabaseOutage:true,healthRecovers:true,realOidcLogin:false};await mkdir('out',{recursive:true});await writeFile('out/self-hosted-compose-result.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}catch(e){if(prepared)console.error(compose('logs','--tail','20','app','idp'));throw e;}
finally{if(prepared)compose('down','-v','--remove-orphans');await rm(root,{recursive:true,force:true});}
