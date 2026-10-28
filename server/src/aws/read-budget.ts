import type { ClientFactory } from './clients.ts';
/** Per collection wrapper: never modifies a shared session client or its guard. */
export function readBudget(clients: ClientFactory, maxCalls = 1000, timeoutMs = 120_000) {
  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  let calls = 0;
  const fail = () => Object.assign(new Error('구성 조회 상한 또는 제한 시간에 도달했습니다. 일부 결과만 표시합니다.'), {name:'CollectionBudgetExceeded'});
  const timer = setTimeout(() => controller.abort(fail()), timeoutMs); timer.unref();
  const wrappers = new WeakMap<object, object>();
  const factory = new Proxy(clients, { get(target, key) {
    if (key !== 'get') return Reflect.get(target,key,target);
    return (...args: Parameters<ClientFactory['get']>) => {
      const client = target.get(...args);
      let wrapper = wrappers.get(client);
      if (!wrapper) {
        wrapper = new Proxy(client, { get(sdk, member) {
          const value = Reflect.get(sdk,member,sdk);
          if (member !== 'send') return typeof value === 'function' ? value.bind(sdk) : value;
          return (command: unknown, options?: Record<string,unknown>) => {
            if (calls >= maxCalls || Date.now() >= deadline || controller.signal.aborted) return Promise.reject(fail());
            calls++;
            return value.call(sdk,command,{...options,abortSignal:controller.signal});
          };
        } });
        wrappers.set(client,wrapper);
      }
      return wrapper;
    };
  } });
  return {clients:factory, summary:()=>({calls,maxCalls,timeoutMs,exhausted:calls>=maxCalls || controller.signal.aborted || Date.now()>=deadline}),dispose:()=>clearTimeout(timer)};
}
