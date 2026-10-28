import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import ts from 'typescript';
import { attachReadOnlyGuard, ReadOnlyViolationError } from './readonly-guard.ts';
import { READ_ONLY_COMMANDS } from './readonly-policy.ts';

test('every current SDK operation/paginator is approved for its actual service and reaches middleware', async () => {
  const imports = new Map<string, { client: string; commands: Set<string> }>();
  async function scan(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await scan(path);
      else if (path.endsWith('.ts') && !path.endsWith('.test.ts')) {
        const source = ts.createSourceFile(path, await readFile(path, 'utf8'), ts.ScriptTarget.Latest, true);
        for (const statement of source.statements) {
          if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
          const module = statement.moduleSpecifier.text;
          const bindings = statement.importClause?.namedBindings;
          if (!module.startsWith('@aws-sdk/client-') || !bindings || !ts.isNamedImports(bindings)) continue;
          const names = bindings.elements.filter(e => !e.isTypeOnly).map(e => e.propertyName?.text ?? e.name.text);
          const client = names.find(n => n.endsWith('Client'));
          if (!client) continue;
          const entry = imports.get(module) ?? { client, commands: new Set<string>() };
          for (const name of names) {
            if (name.endsWith('Command')) entry.commands.add(name);
            if (name.startsWith('paginate')) entry.commands.add(`${name.slice(8)}Command`);
          }
          imports.set(module, entry);
        }
      }
    }
  }
  await scan(fileURLToPath(new URL('..', import.meta.url)));
  for (const [module, { client: clientName, commands }] of imports) {
    assert.deepEqual([...READ_ONLY_COMMANDS[clientName]].sort(), [...commands].sort(), clientName);
    const sdk = await import(module);
    const client = attachReadOnlyGuard(new sdk[clientName]({ region: 'us-east-1', credentials: { accessKeyId: 'dummy', secretAccessKey: 'dummy' } }));
    // Stop before serialization/signing/network. Uses the real SDK's clientName/commandName context.
    client.middlewareStack.add(() => async () => ({ output: { reached: true, $metadata: {} } }), { step: 'initialize', priority: 'low', name: 'testStopBeforeNetwork' });
    for (const command of commands) assert.equal((await (client as any).send(new sdk[command]({}))).reached, true, `${clientName}/${command}`);
    (client as any).destroy();
  }
});

test('secret retrieval and session-token issuance fail before network/credential access', async () => {
  for (const [module, clientName, command] of [
    ['@aws-sdk/client-secrets-manager', 'SecretsManagerClient', 'GetSecretValueCommand'],
    ['@aws-sdk/client-sts', 'STSClient', 'GetSessionTokenCommand'],
  ]) {
    const sdk = await import(module);
    const client: any = attachReadOnlyGuard(new sdk[clientName]({ region: 'us-east-1', credentials: async () => { assert.fail('credential provider must not run'); } }));
    await assert.rejects(client.send(new sdk[command]({})), ReadOnlyViolationError);
    client.destroy();
  }
});
