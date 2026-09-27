/* How big the agent's reads are on a real, large page (needs the network). */
import { launch, sleep } from '../harness';

(async () => {
  const { session: s, stop } = await launch();
  await s.run(() => s.newPage('https://en.wikipedia.org/wiki/Web_browser'));
  await sleep(1500);
  const full = await s.run(() => s.takeSnapshot({ limit: 100000 }));
  const def = await s.run(() => s.takeSnapshot());
  const search = await s.run(() => s.takeSnapshot({ textContains: 'search' }));
  const rp = JSON.stringify(await s.run(() => s.readPage({ maxChars: 3000 })));
  const count = (t: string) => (t.match(/^\s*\[\d+\]/gm) || []).length;
  console.log(`full snapshot (no limit)        ${full.length} chars, ${count(full)} elements`);
  console.log(`default snapshot (limit 200)    ${def.length} chars`);
  console.log(`snapshot textContains "search"  ${search.length} chars, ${count(search)} elements`);
  console.log(`read_page maxChars 3000         ${rp.length} chars`);
  await stop(); process.exit(0);
})();
