/** A page with the controls the agent had trouble with: radios drawn by the page over hidden
 *  inputs, an ARIA radio, a password field, a button that changes the page, inert text, and a
 *  button that keeps the page changing for a while (a single-page app loading). */
export const CONTROLS_PAGE = `<!doctype html><title>controls</title>
<style>.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
label{display:inline-block;padding:6px 10px;margin:4px;border:1px solid #888}</style>
<body>
<fieldset><legend>Domain type</legend>
<label id=l1><input class=sr type=radio name=dom value=user id=r1> User alias domain</label>
<label id=l2><input class=sr type=radio name=dom value=secondary id=r2 checked> Secondary domain</label>
</fieldset>
<div id=aria role=radio aria-checked=false tabindex=0 style="display:inline-block;padding:6px">Workers</div>
<input id=pw type=password name=password>
<button id=change>Change</button> <span id=msg>ready</span>
<p id=inert>Plain text nobody listens to.</p>
<button id=load>Load</button> <div id=feed></div>
<script>
  document.getElementById('change').addEventListener('click', () => { document.getElementById('msg').textContent = 'changed'; });
  document.getElementById('aria').addEventListener('click', (e) => e.currentTarget.setAttribute('aria-checked', 'true'));
  document.getElementById('load').addEventListener('click', () => {
    let n = 0; const t = setInterval(() => { const d = document.createElement('div'); d.textContent = 'item ' + n; document.getElementById('feed').appendChild(d); if (++n === 12) { clearInterval(t); document.getElementById('feed').append('Done'); } }, 100);
  });
</script></body>`;
