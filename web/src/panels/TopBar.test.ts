import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TopBar } from './TopBar';

test('navigation exposes topology, types and monitoring', () => {
  const html = renderToStaticMarkup(createElement(TopBar));
  const tabs = [...html.matchAll(/role="tab"[^>]*>(.*?)<\/button>/g)].map((m) => m[1]);
  assert.deepEqual(tabs, ['토폴로지', '유형별', '모니터링']);
});
