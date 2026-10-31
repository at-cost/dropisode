/**
 * A small script for the account, billing and sign-in pages. A form with
 * data-api="/path" is sent as JSON with fetch (data-method, default POST).
 * Number inputs are sent as numbers. On success: follow a returned `url`, else
 * go to data-next, else reload. Errors show in the form's [data-error] element.
 * data-confirm asks first.
 */
export const CLIENT_JS = `
document.addEventListener("submit", async (e) => {
  const f = e.target;
  if (!(f instanceof HTMLFormElement) || !f.dataset.api) return;
  e.preventDefault();
  if (f.dataset.confirm && !confirm(f.dataset.confirm)) return;
  const out = f.querySelector("[data-error]");
  if (out) out.textContent = "";
  const body = {};
  for (const el of f.elements) {
    if (!el.name || el.disabled) continue;
    body[el.name] = el.type === "number" ? Number(el.value) : el.value;
  }
  const btn = f.querySelector("button");
  if (btn) btn.disabled = true;
  try {
    const res = await fetch(f.dataset.api, { method: f.dataset.method || "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong");
    if (data.url) location.href = data.url;
    else if (f.dataset.next) location.href = f.dataset.next;
    else location.reload();
  } catch (err) {
    if (out) out.textContent = err.message;
    else alert(err.message);
    if (btn) btn.disabled = false;
  }
});
`;

export const PAGE_CSS = `
form.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0}
.stack>h2{margin-top:36px}.nowrap{white-space:nowrap}
.topup{display:flex;flex-wrap:wrap;gap:16px 28px;align-items:center;padding:18px 20px}
.topup .presets{display:flex;gap:10px}.topup .presets form{margin:0}
.topup .preset{font-family:var(--display);font-weight:800;font-size:24px;padding:10px 22px;border-radius:12px;min-width:84px}
.topup .custom{gap:10px}.usd-input{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--text-2);border-radius:8px;padding:0 0 0 10px;background:var(--surface)}
.usd-input input{border:0;width:90px;background:transparent}
.grid>.card .big{font-family:var(--display);font-size:34px;font-weight:800;line-height:1.1}
form.inline{display:inline}
.err{color:var(--bad);font-size:13px;min-height:1em;margin:4px 0 0}
.ok{color:var(--ok)}
.stack>*+*{margin-top:12px}
.big{font-size:26px;font-weight:700;font-variant-numeric:tabular-nums}
label{display:block;font-size:13px;color:var(--text-2);margin-bottom:4px}
.narrow{max-width:420px}
.wide-input{flex:1;min-width:200px}
.tag{font-size:12px;border:1px solid var(--border);border-radius:999px;padding:1px 8px;color:var(--text-2)}
.scroll{overflow-x:auto}
`;
