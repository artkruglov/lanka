declare namespace Cloudflare {
  interface Env {
    AGENT_DAILY_RUN_LIMIT?: string;
    AGENT_SITE_DAILY_RUN_LIMIT?: string;
    DB: D1Database;
    BUCKET: R2Bucket;
    LLM_API_URL?: string;
    LLM_API_KEY?: string;
    LLM_MODEL?: string;
  }
}
