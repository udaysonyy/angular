/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {EnvironmentInjector, Injector, ɵRuntimeError as RuntimeError} from '@angular/core';
import {concat, defer, from, MonoTypeOperatorFunction, Observable, of, OperatorFunction, pipe} from 'rxjs';
import {concatMap, filter, first, map, mergeMap, tap} from 'rxjs/operators';

import {RuntimeErrorCode} from '../errors';
import {ActivationStart, ChildActivationStart, Event} from '../events';
import {CanActivateChildFn, CanActivateFn, CanDeactivateFn, CanLoadFn, CanMatch, CanMatchFn, Route} from '../models';
import {NavigationTransition} from '../router';
import {ActivatedRouteSnapshot, RouterStateSnapshot} from '../router_state';
import {navigationCancelingError, REDIRECTING_CANCELLATION_REASON} from '../shared';
import {UrlSegment, UrlSerializer, UrlTree} from '../url_tree';
import {wrapIntoObservable} from '../utils/collection';
import {CanActivate, CanDeactivate, getCanActivateChild, getToken} from '../utils/preactivation';
import {isBoolean, isCanActivate, isCanActivateChild, isCanDeactivate, isCanLoad, isCanMatch, isFunction, isUrlTree} from '../utils/type_guards';

import {prioritizedGuardValue} from './prioritized_guard_value';

const NG_DEV_MODE = typeof ngDevMode === 'undefined' || !!ngDevMode;

export function checkGuards(moduleInjector: Injector, forwardEvent?: (evt: Event) => void):
    MonoTypeOperatorFunction<NavigationTransition> {
  return mergeMap(t => {
    const {targetSnapshot, currentSnapshot, guards: {canActivateChecks, canDeactivateChecks}} = t;
    if (canDeactivateChecks.length === 0 && canActivateChecks.length === 0) {
      return of({...t, guardsResult: true});
    }

    return runCanDeactivateChecks(
               canDeactivateChecks, targetSnapshot!, currentSnapshot, moduleInjector)
        .pipe(
            mergeMap(canDeactivate => {
              return canDeactivate && isBoolean(canDeactivate) ?
                  runCanActivateChecks(
                      targetSnapshot!, canActivateChecks, moduleInjector, forwardEvent) :
                  of(canDeactivate);
            }),
            map(guardsResult => ({...t, guardsResult})));
  });
}

function runCanDeactivateChecks(
    checks: CanDeactivate[], futureRSS: RouterStateSnapshot, currRSS: RouterStateSnapshot,
    moduleInjector: Injector) {
  return from(checks).pipe(
      mergeMap(
          check =>
              runCanDeactivate(check.component, check.route, currRSS, futureRSS, moduleInjector)),
      first(result => {
        return result !== true;
      }, true as boolean | UrlTree));
}

function runCanActivateChecks(
    futureSnapshot: RouterStateSnapshot, checks: CanActivate[], moduleInjector: Injector,
    forwardEvent?: (evt: Event) => void) {
  return from(checks).pipe(
      concatMap((check: CanActivate) => {
        return concat(
            fireChildActivationStart(check.route.parent, forwardEvent),
            fireActivationStart(check.route, forwardEvent),
            runCanActivateChild(futureSnapshot, check.path, moduleInjector),
            runCanActivate(futureSnapshot, check.route, moduleInjector));
      }),
      first(result => {
        return result !== true;
      }, true as boolean | UrlTree));
}

/**
 * This should fire off `ActivationStart` events for each route being activated at this
 * level.
 * In other words, if you're activating `a` and `b` below, `path` will contain the
 * `ActivatedRouteSnapshot`s for both and we will fire `ActivationStart` for both. Always
 * return
 * `true` so checks continue to run.
 */
function fireActivationStart(
    snapshot: ActivatedRouteSnapshot|null,
    forwardEvent?: (evt: Event) => void): Observable<boolean> {
  if (snapshot !== null && forwardEvent) {
    forwardEvent(new ActivationStart(snapshot));
  }
  return of(true);
}

/**
 * This should fire off `ChildActivationStart` events for each route being activated at this
 * level.
 * In other words, if you're activating `a` and `b` below, `path` will contain the
 * `ActivatedRouteSnapshot`s for both and we will fire `ChildActivationStart` for both. Always
 * return
 * `true` so checks continue to run.
 */
function fireChildActivationStart(
    snapshot: ActivatedRouteSnapshot|null,
    forwardEvent?: (evt: Event) => void): Observable<boolean> {
  if (snapshot !== null && forwardEvent) {
    forwardEvent(new ChildActivationStart(snapshot));
  }
  return of(true);
}

function runCanActivate(
    futureRSS: RouterStateSnapshot, futureARS: ActivatedRouteSnapshot,
    moduleInjector: Injector): Observable<boolean|UrlTree> {
  const canActivate = futureARS.routeConfig ? futureARS.routeConfig.canActivate : null;
  if (!canActivate || canActivate.length === 0) return of(true);

  const canActivateObservables = canActivate.map((c: any) => {
    return defer(() => {
      const guard = getToken(c, futureARS, moduleInjector);
      let observable;
      if (isCanActivate(guard)) {
        observable = wrapIntoObservable(guard.canActivate(futureARS, futureRSS));
      } else if (isFunction<CanActivateFn>(guard)) {
        observable = wrapIntoObservable(guard(futureARS, futureRSS));
      } else {
        throw new RuntimeError(
            RuntimeErrorCode.INVALID_GUARD, NG_DEV_MODE && 'Invalid CanActivate guard');
      }
      return observable.pipe(first());
    });
  });
  return of(canActivateObservables).pipe(prioritizedGuardValue());
}

function runCanActivateChild(
    futureRSS: RouterStateSnapshot, path: ActivatedRouteSnapshot[],
    moduleInjector: Injector): Observable<boolean|UrlTree> {
  const futureARS = path[path.length - 1];

  const canActivateChildGuards = path.slice(0, path.length - 1)
                                     .reverse()
                                     .map(p => getCanActivateChild(p))
                                     .filter(_ => _ !== null);

  const canActivateChildGuardsMapped = canActivateChildGuards.map((d: any) => {
    return defer(() => {
      const guardsMapped = d.guards.map((c: any) => {
        const guard = getToken(c, d.node, moduleInjector);
        let observable;
        if (isCanActivateChild(guard)) {
          observable = wrapIntoObservable(guard.canActivateChild(futureARS, futureRSS));
        } else if (isFunction<CanActivateChildFn>(guard)) {
          observable = wrapIntoObservable(guard(futureARS, futureRSS));
        } else {
          throw new RuntimeError(
              RuntimeErrorCode.INVALID_GUARD, NG_DEV_MODE && 'Invalid CanActivateChild guard');
        }
        return observable.pipe(first());
      });
      return of(guardsMapped).pipe(prioritizedGuardValue());
    });
  });
  return of(canActivateChildGuardsMapped).pipe(prioritizedGuardValue());
}

function runCanDeactivate(
    component: Object|null, currARS: ActivatedRouteSnapshot, currRSS: RouterStateSnapshot,
    futureRSS: RouterStateSnapshot, moduleInjector: Injector): Observable<boolean|UrlTree> {
  const canDeactivate = currARS && currARS.routeConfig ? currARS.routeConfig.canDeactivate : null;
  if (!canDeactivate || canDeactivate.length === 0) return of(true);
  const canDeactivateObservables = canDeactivate.map((c: any) => {
    const guard = getToken(c, currARS, moduleInjector);
    let observable;
    if (isCanDeactivate(guard)) {
      observable = wrapIntoObservable(guard.canDeactivate(component!, currARS, currRSS, futureRSS));
    } else if (isFunction<CanDeactivateFn<any>>(guard)) {
      observable = wrapIntoObservable(guard(component, currARS, currRSS, futureRSS));
    } else {
      throw new RuntimeError(
          RuntimeErrorCode.INVALID_GUARD, NG_DEV_MODE && 'Invalid CanDeactivate guard');
    }
    return observable.pipe(first());
  });
  return of(canDeactivateObservables).pipe(prioritizedGuardValue());
}

export function runCanLoadGuards(
    injector: EnvironmentInjector, route: Route, segments: UrlSegment[],
    urlSerializer: UrlSerializer): Observable<boolean> {
  const canLoad = route.canLoad;
  if (canLoad === undefined || canLoad.length === 0) {
    return of(true);
  }

  const canLoadObservables = canLoad.map((injectionToken: any) => {
    const guard = injector.get(injectionToken);
    let guardVal;
    if (isCanLoad(guard)) {
      guardVal = guard.canLoad(route, segments);
    } else if (isFunction<CanLoadFn>(guard)) {
      guardVal = guard(route, segments);
    } else {
      throw new RuntimeError(
          RuntimeErrorCode.INVALID_GUARD, NG_DEV_MODE && 'Invalid CanLoad guard');
    }
    return wrapIntoObservable(guardVal);
  });

  return of(canLoadObservables)
      .pipe(
          prioritizedGuardValue(),
          redirectIfUrlTree(urlSerializer),
      );
}

function redirectIfUrlTree(urlSerializer: UrlSerializer):
    OperatorFunction<UrlTree|boolean, boolean> {
  return pipe(
      tap((result: UrlTree|boolean) => {
        if (!isUrlTree(result)) return;

        const error: Error&{url?: UrlTree} = navigationCancelingError(
            REDIRECTING_CANCELLATION_REASON + urlSerializer.serialize(result));
        error.url = result;
        throw error;
      }),
      map(result => result === true),
  );
}

export function runCanMatchGuards(
    injector: Injector, route: Route, segments: UrlSegment[],
    urlSerializer: UrlSerializer): Observable<boolean> {
  const canMatch = route.canMatch;
  if (!canMatch || canMatch.length === 0) return of(true);

  const canMatchObservables = canMatch.map(injectionToken => {
    const guard = injector.get<CanMatch|CanMatchFn>(injectionToken);
    const guardVal = isCanMatch(guard) ? guard.canMatch(route, segments) : guard(route, segments);
    return wrapIntoObservable(guardVal);
  });

  return of(canMatchObservables)
      .pipe(
          prioritizedGuardValue(),
          redirectIfUrlTree(urlSerializer),
      );
}
