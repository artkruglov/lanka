import type {ChatDatabase} from './chat-database';

/** Two parser slots per database, shared by owners and server processes. No long owner transaction. */
export async function withSourceExtractionSlot<T>(db:ChatDatabase,run:(signal:AbortSignal)=>Promise<T>):Promise<T>{
  const client=await db.pool.connect(),abort=new AbortController();
  let slot:string|undefined,destroy=false;
  const lost=()=>{destroy=true;abort.abort();};
  client.on('error',lost);
  try {
    for(let i=0;i<2;i++){
      const key=`lanka:source-extraction:${i}`;
      const result=await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired',[key]);
      if(result.rows[0].acquired){slot=key;break;}
    }
    if(!slot)throw Error('Сервер уже читает два файла. Повторите чтение через несколько секунд.');
    const result=await run(abort.signal);
    if(abort.signal.aborted)throw Error('Чтение прервано: соединение с хранилищем потеряно. Повторите загрузку.');
    await client.query('SELECT 1');
    return result;
  }finally{
    if(slot&&!destroy)try{await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[slot]);}catch{destroy=true;}
    client.removeListener('error',lost);client.release(destroy);
  }
}
