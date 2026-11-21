import type { CoreCtx, CoreEnv } from '../core';

export type { Deps, Session } from '../core';

/** SplitTrip's bindings are exactly what the core needs. */
export type Env = CoreEnv;

export interface TripRow {
  id: string;
  created_by: string | null;
  base_currency: string;
  expense_currency: string;
  version: number;
  isMember: boolean;
}

/** The core's context plus what SplitTrip's trip guards add. */
export interface Ctx extends CoreCtx<Env> {
  trip?: TripRow;            // set by the member/creator guards for every route with :tripId
}
