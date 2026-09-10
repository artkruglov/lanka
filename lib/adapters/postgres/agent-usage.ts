import type {PoolClient} from 'pg';
/** Caller holds the existing tenant:owner advisory lock for any admission decision. */
export async function agentUsage(c:PoolClient,tenant:string,owner:string){
 const r=await c.query(`WITH boundary AS (SELECT date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS start)
 SELECT ((SELECT count(*) FROM lanka.agent_events e JOIN lanka.agent_sessions s ON s.tenant_id=e.tenant_id AND s.id=e.session_id
 WHERE e.tenant_id=$1 AND s.owner_id=$2 AND e.kind='run.started' AND e.created_at>=boundary.start)
 +(SELECT count(*) FROM lanka.agent_bridge_executions e JOIN lanka.agent_sessions s ON s.tenant_id=e.tenant_id AND s.id=e.session_id
 WHERE e.tenant_id=$1 AND s.owner_id=$2 AND e.reserved_at>=boundary.start))::int AS used,
 (SELECT count(*)::int FROM lanka.jobs j JOIN lanka.agent_sessions s ON s.tenant_id=j.tenant_id AND s.id=j.session_id
 WHERE j.tenant_id=$1 AND s.owner_id=$2 AND j.status='queued') AS queued,
 boundary.start+interval '24 hours' AS resets_at FROM boundary`,[tenant,owner]);
 const {used,queued,resets_at}=r.rows[0];return {limit:20,used,queued,remaining:Math.max(0,20-used-queued),resetsAt:resets_at.toISOString()};
}
