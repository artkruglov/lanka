// Test-only provider for the isolated Compose check. Never deploy as an identity provider.
import {createServer} from 'node:https';
import {readFileSync} from 'node:fs';
import {createPublicKey,createHash,randomUUID,sign} from 'node:crypto';
const key=readFileSync('/run/secrets/key.pem'),issuer='https://idp:4443',redirect='https://lanka.example.invalid/auth/callback',codes=new Map();
const jwk={...createPublicKey(key).export({format:'jwk'}),kid:'qa',alg:'RS256',use:'sig'};
createServer({key,cert:readFileSync('/run/secrets/cert.pem')},async(req,res)=>{
 const url=new URL(req.url,issuer);console.log(req.method,url.pathname);const json=(body,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
 if(url.pathname==='/.well-known/openid-configuration')return json({issuer,authorization_endpoint:issuer+'/authorize',token_endpoint:issuer+'/token',jwks_uri:issuer+'/jwks',response_types_supported:['code'],subject_types_supported:['public'],id_token_signing_alg_values_supported:['RS256'],code_challenge_methods_supported:['S256']});
 if(url.pathname==='/jwks')return json({keys:[jwk]});
 if(url.pathname==='/authorize'){
  if(url.searchParams.get('redirect_uri')!==redirect||url.searchParams.get('client_id')!=='qa'||url.searchParams.get('code_challenge_method')!=='S256')return json({error:'invalid_request'},400);
  const code=randomUUID();codes.set(code,{nonce:url.searchParams.get('nonce'),challenge:url.searchParams.get('code_challenge'),subject:url.searchParams.get('test_user')==='other'?'compose-test-other':'compose-test-owner'});
  const target=new URL(redirect);target.searchParams.set('state',url.searchParams.get('state'));target.searchParams.set('code',code);
  res.writeHead(302,{Location:target.href});res.end();return;
 }
 if(url.pathname==='/token'&&req.method==='POST'){
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=new URLSearchParams(Buffer.concat(chunks).toString());
  const record=codes.get(body.get('code'));codes.delete(body.get('code'));
  const credentials=Buffer.from((req.headers.authorization??'').replace(/^Basic /,''),'base64').toString().split(':').map(v=>decodeURIComponent(v.replaceAll('+',' ')));
  if(!record||credentials.length!==2||credentials[0]!=='qa'||credentials[1]!=='qa-secret'||body.get('redirect_uri')!==redirect||createHash('sha256').update(body.get('code_verifier')??'').digest('base64url')!==record.challenge)return json({error:'invalid_grant'},400);
  const now=Math.floor(Date.now()/1000),encode=v=>Buffer.from(JSON.stringify(v)).toString('base64url');
  const payload=encode({alg:'RS256',kid:'qa'})+'.'+encode({iss:issuer,sub:record.subject,aud:'qa',iat:now,exp:now+3600,nonce:record.nonce,name:'Compose QA',email:'qa@example.invalid',email_verified:true});
  return json({access_token:'test-only',token_type:'Bearer',expires_in:3600,id_token:payload+'.'+sign('RSA-SHA256',Buffer.from(payload),key).toString('base64url')});
 }
 return json({error:'not_found'},404);
}).listen(4443,'0.0.0.0');
