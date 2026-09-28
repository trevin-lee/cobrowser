/* The rule (src/browser/guards.ts) in the panel's tools: no payment clicks, no typed secrets,
 * each with its override — and nothing else is held back. */
import { suite, launch, serve, html, sleep } from './harness';

const PAGE = `<!doctype html><title>checkout</title><body>
<button id=pay>Pay now</button><button id=next>Continue</button><button id=out>Sign out</button>
<form><input id=email name=email placeholder="Email"><input id=pw type=password name=password><input id=otp name=otp autocomplete="one-time-code" placeholder="Verification code"><input id=card name=cardnumber placeholder="Card number"></form>
<script>window.__clicks = []; for (const id of ['pay','next','out']) document.getElementById(id).addEventListener('click', () => window.__clicks.push(id));</script></body>`;

suite('guards', async (r) => {
  const srv = await serve((_q, res) => { const [st, h, b] = html(PAGE); res.writeHead(st, h); res.end(b); });
  const { session: s, stop } = await launch();
  try {
    await s.run(() => s.newPage(srv.base + '/'));
    const clicks = async () => (await s.evaluateScript('() => window.__clicks')) as string[];
    const val = async (id: string) => (await s.evaluateScript(`() => document.getElementById(${JSON.stringify(id)}).value`)) as string;

    const pay = await s.run(() => s.click({ selector: '#pay' }));
    r.check('a payment button is refused and reported, not clicked', 'refused' in pay && pay.refused === 'payment' && pay.label === 'Pay now' && (await clicks()).length === 0, pay);
    const paid = await s.run(() => s.click({ selector: '#pay', allowPayment: true }));
    r.check('allowPayment clicks it', 'clicked' in paid && JSON.stringify(await clicks()) === '["pay"]', paid);
    await s.run(() => s.click({ selector: '#next' }));
    await s.run(() => s.click({ selector: '#out' }));
    r.check('ordinary buttons, and sign-out, are clicked (sign-out was never part of the rule)', JSON.stringify(await clicks()) === '["pay","next","out"]', await clicks());

    const pw = await s.run(() => s.fill({ selector: '#pw', value: 'hunter2' }));
    r.check('fill refuses a password field and points to fill_credentials', pw.filled === 0 && pw.refused?.[0] === 'password' && /fill_credentials/.test(pw.needsUserAction ?? '') && (await val('pw')) === '', pw);
    const otp = await s.run(() => s.fill({ selector: '#otp', value: '123456' }));
    r.check('fill refuses a one-time-code field that is type=text', otp.filled === 0 && (await val('otp')) === '', otp);
    const form = await s.run(() => s.fillForm([{ selector: '#email', value: 'me@example.com' }, { selector: '#card', value: '4242424242424242' }]));
    r.check('fill_form fills the ordinary field and reports the card field it left', form.filled === 1 && form.refused?.join() === 'cardnumber' && (await val('email')) === 'me@example.com' && (await val('card')) === '', form);
    await s.evaluateScript('() => document.getElementById("pw").focus()');
    const typed = await s.run(() => s.typeText('hunter2'));
    r.check('type_text refuses when a password field has focus', typed.filled === 0 && (await val('pw')) === '', typed);
    const allowed = await s.run(() => s.fill({ selector: '#pw', value: 'given-by-human', allowCredentials: true }));
    await sleep(100);
    r.check('allowCredentials fills it', allowed.filled === 1 && (await val('pw')) === 'given-by-human', allowed);
  } finally {
    srv.close(); await stop();
  }
});
