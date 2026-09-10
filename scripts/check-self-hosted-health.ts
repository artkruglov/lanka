import {readFile} from 'node:fs/promises';
import {request} from 'node:http';
import {Pool} from 'pg';
import {z} from 'zod';
const deadline=setTimeout(()=>process.exit(1),4500);deadline.unref();
let pool:Pool|undefined;
try{
 const args=process.argv.slice(2);
 if(args.length!==2||args[0]!=='--config'||!args[1].startsWith('/'))throw Error('Configuration required');
 const config=z.object({port:z.number().int().min(1).max(65535).default(4318),auth:z.object({origin:z.string().url()}),connection:z.object({host:z.string().min(1),port:z.number().int().positive().max(65535),database:z.string().min(1),user:z.string().min(1),password:z.string().optional(),ssl:z.union([z.literal(true),z.object({ca:z.string().optional(),rejectUnauthorized:z.literal(true).optional()}).strict()]).optional()}).strict()}).parse(JSON.parse(await readFile(args[1],'utf8')));
 await new Promise<void>((resolve,reject)=>{
  const req=request({hostname:'127.0.0.1',port:config.port,path:'/auth/session',headers:{Host:new URL(config.auth.origin).host},timeout:2000},res=>{res.resume();res.on('end',()=>res.statusCode===401?resolve():reject(Error('Unexpected authentication boundary')));res.on('error',reject);});
  req.on('timeout',()=>req.destroy(Error('HTTP timeout')));req.on('error',reject);req.end();
 });
 pool=new Pool({...config.connection,max:1,connectionTimeoutMillis:2000,query_timeout:2000});pool.on('error',()=>{});
 await pool.query('SELECT 1');
}catch{process.exitCode=1;}
finally{await pool?.end();clearTimeout(deadline);}
