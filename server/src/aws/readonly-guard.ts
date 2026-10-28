/**
 * Read-only guard.
 * Every SDK client created by Orrery gets this middleware. It rejects any
 * command not explicitly approved for its SDK service *before* a
 * request is signed or sent, so a bug (or a future contributor) cannot turn
 * the tool into something that mutates the account.
 */

import { READ_ONLY_COMMANDS } from './readonly-policy.ts';

export class ReadOnlyViolationError extends Error {
  constructor(public readonly commandName: string) {
    super(`읽기 전용 모드에서 허용되지 않는 호출입니다: ${commandName}`);
    this.name = 'ReadOnlyViolationError';
  }
}

export function isReadOnlyCommand(commandName: string, clientName?: string): boolean {
  return clientName === undefined
    ? Object.values(READ_ONLY_COMMANDS).some((commands) => commands.has(commandName))
    : Object.hasOwn(READ_ONLY_COMMANDS, clientName) && READ_ONLY_COMMANDS[clientName].has(commandName);
}

export interface GuardableClient {
  // The SDK's MiddlewareStack has several overloads; we only need `add`.
  middlewareStack: { add: (middleware: any, options: any) => void };
}

export function attachReadOnlyGuard<T extends GuardableClient>(client: T): T {
  client.middlewareStack.add(
    (next: (args: unknown) => Promise<unknown>, context: { commandName?: string; clientName?: string }) => async (args: unknown) => {
      const name = context.commandName ?? 'UnknownCommand';
      if (!context.clientName || !isReadOnlyCommand(name, context.clientName)) throw new ReadOnlyViolationError(name);
      return next(args);
    },
    { step: 'initialize', name: 'orreryReadOnlyGuard', priority: 'high', tags: ['ORRERY_READ_ONLY'] },
  );
  return client;
}
