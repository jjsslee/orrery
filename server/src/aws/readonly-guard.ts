/**
 * Read-only guard.
 * Every SDK client created by Orrery gets this middleware. It rejects any
 * command whose name is not a Describe/List/Get/Head/Lookup call *before* a
 * request is signed or sent, so a bug (or a future contributor) cannot turn
 * the tool into something that mutates the account.
 */

const READ_ONLY_PATTERN = /^(Describe|List|Get|Head|Lookup|BatchGet)[A-Z]/;

export class ReadOnlyViolationError extends Error {
  constructor(public readonly commandName: string) {
    super(`읽기 전용 모드에서 허용되지 않는 호출입니다: ${commandName}`);
    this.name = 'ReadOnlyViolationError';
  }
}

export function isReadOnlyCommand(commandName: string): boolean {
  return READ_ONLY_PATTERN.test(commandName);
}

export interface GuardableClient {
  // The SDK's MiddlewareStack has several overloads; we only need `add`.
  middlewareStack: { add: (middleware: any, options: any) => void };
}

export function attachReadOnlyGuard<T extends GuardableClient>(client: T): T {
  client.middlewareStack.add(
    (next: (args: unknown) => Promise<unknown>, context: { commandName?: string }) => async (args: unknown) => {
      const name = context.commandName ?? 'UnknownCommand';
      if (!isReadOnlyCommand(name)) throw new ReadOnlyViolationError(name);
      return next(args);
    },
    { step: 'initialize', name: 'orreryReadOnlyGuard', priority: 'high', tags: ['ORRERY_READ_ONLY'] },
  );
  return client;
}
