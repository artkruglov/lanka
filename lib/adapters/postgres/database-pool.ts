import type {Pool} from 'pg';
/** The persistence layer needs SQL and connection lifetime, not Pool implementation details. */
export type DatabasePool=Pick<Pool,'query'|'connect'|'end'>;
