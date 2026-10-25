import type { DeRouterBreaker, DeRouterRevert } from "../../telemetry/config.js";

/** Router renders (and, once off, clean renders) a single revert stays remembered or an off router waits. */
export const DE_ROUTER_BREAKER_WINDOW = 20;

/** The one place that decides when the parallel-drawElement router goes off for an install and when it comes back. */
export function isRouterOff(breaker: DeRouterBreaker | undefined, version: string): boolean {
  return breaker?.trip !== undefined && breaker.trip.version === version;
}

/** A router outcome other than a clean "routed": off after a second one inside the window. */
export function afterRevert(
  breaker: DeRouterBreaker | undefined,
  revert: DeRouterRevert,
): DeRouterBreaker {
  const strike = breaker?.strike;
  const second =
    strike !== undefined && revert.atRender - strike.atRender < DE_ROUTER_BREAKER_WINDOW;
  return second ? { trip: { ...revert, cleanRenders: 0 } } : { strike: revert };
}

/** A render finished with the router off; the Nth one brings it back (undefined = armed). */
export function afterCleanRender(
  breaker: DeRouterBreaker | undefined,
): DeRouterBreaker | undefined {
  const trip = breaker?.trip;
  if (trip === undefined) return breaker;
  if (trip.cleanRenders + 1 >= DE_ROUTER_BREAKER_WINDOW) return undefined;
  return { trip: { ...trip, cleanRenders: trip.cleanRenders + 1 } };
}

/** A state recorded by another CLI version is stale: a lone strike is dropped, a trip is lifted. */
export function forVersion(
  breaker: DeRouterBreaker | undefined,
  version: string,
): DeRouterBreaker | undefined {
  if (breaker?.trip !== undefined) return breaker.trip.version === version ? breaker : undefined;
  return breaker?.strike?.version === version ? breaker : undefined;
}
