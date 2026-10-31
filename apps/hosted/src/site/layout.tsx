/** @jsxImportSource hono/jsx */
/** The shared page shell for every server-rendered page (site, sign-in, account, billing, admin). */
import type { Child } from "hono/jsx";
import type { SessionUser } from "../context";

export const CSS = `
:root{color-scheme:light;--bg:#F4F2FA;--surface:#fff;--sunken:#EAE6F3;--border:#D9D3E6;--text:#191322;--text-2:#5A5266;--accent:#C2214F;--accent-text:#fff;--plum:#1D0F2B;--plum-2:#2B1840;--rouge:#E5336A;--gold:#F4C24E;--ok:#2f6b3a;--warn:#9a5b00;--bad:#a12a2a;--radius:10px;--display:"Big Shoulders Display","Arial Narrow",sans-serif;--font:"Public Sans",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#140B1E;--surface:#1E1329;--sunken:#2A1C38;--border:#3B2B4D;--text:#F2EEF8;--text-2:#B9AECA;--accent:#F2517F;--accent-text:#1A0710;--ok:#7fc48a;--warn:#e0a84a;--bad:#ef8a8a}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 var(--font)}
a{color:var(--accent)}main{max-width:980px;margin:0 auto;padding:24px 16px 64px}
header.top{display:flex;gap:10px 16px;align-items:center;flex-wrap:wrap;padding:12px 16px;border-bottom:1px solid var(--border);background:var(--surface)}
header.top .brand{font-family:var(--display);font-weight:800;font-size:24px;line-height:1;color:var(--text);text-decoration:none;letter-spacing:.01em}
header.top nav{display:flex;gap:14px;flex-wrap:wrap;flex:1}header.top nav a{color:var(--text-2);text-decoration:none}header.top nav a:hover{color:var(--text)}
header.top nav.user{flex:0 0 auto}
h1{font-family:var(--display);font-weight:800;font-size:40px;line-height:1.05;margin:8px 0 12px;letter-spacing:.005em}h2{font-family:var(--display);font-weight:700;font-size:28px;margin:32px 0 10px;line-height:1.1}h3{font-size:16px;margin:20px 0 6px}
p,li{max-width:72ch}ul,ol{padding-left:22px}li{margin:3px 0}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px}
.muted{color:var(--text-2)}.small{font-size:13px}.mono{font-family:var(--mono)}
code,pre,kbd{font-family:var(--mono);font-size:13px}code{background:var(--sunken);padding:1px 5px;border-radius:4px}
pre{background:var(--sunken);border:1px solid var(--border);border-radius:8px;padding:12px;overflow-x:auto;white-space:pre-wrap;word-break:break-word}pre code{background:none;padding:0}
table{border-collapse:collapse;width:100%;background:var(--surface)}th,td{text-align:left;padding:7px 9px;border-bottom:1px solid var(--border);vertical-align:top}th{font-size:13px;color:var(--text-2);font-weight:600}td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
tr.hl td{background:var(--sunken)}tfoot td{font-weight:600;border-top:2px solid var(--border)}
.table-wrap,.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;border:1px solid var(--border);border-radius:var(--radius);margin:10px 0}
.table-wrap table,.scroll table{min-width:560px}.table-wrap tr:last-child td{border-bottom:0}
input,select,textarea{font:inherit;color:var(--text);background:var(--surface);border:1px solid var(--text-2);border-radius:8px;padding:8px 10px;max-width:100%}
label{display:block}label .lbl{display:block;font-size:13px;color:var(--text-2);margin-bottom:3px}
button,.button{font:inherit;cursor:pointer;border:1px solid var(--accent);background:var(--accent);color:var(--accent-text);border-radius:8px;padding:8px 14px;text-decoration:none;display:inline-block}
button.secondary,.button.secondary{background:transparent;color:var(--accent)}
.notice{border-left:4px solid var(--warn);background:var(--surface);padding:10px 14px;border-radius:6px}
.notice.strong{border:1px solid var(--warn);border-left-width:6px;padding:14px 16px}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.hero{padding:16px 0 8px}.hero h1{font-size:34px;max-width:22ch}.lede{font-size:17px;color:var(--text-2);max-width:62ch}
.actions{display:flex;gap:10px;flex-wrap:wrap;margin:18px 0}
.steps{list-style:none;padding:0;counter-reset:s;display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
.steps li{counter-increment:s;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;margin:0;max-width:none}
.steps li::before{content:counter(s);display:inline-block;width:24px;height:24px;line-height:24px;text-align:center;border-radius:50%;background:var(--accent);color:var(--accent-text);font-weight:700;font-size:13px;margin-right:8px}
.tag{display:inline-block;font-size:12px;padding:1px 8px;border-radius:999px;border:1px solid var(--border);background:var(--sunken);color:var(--text-2);white-space:nowrap}
.tag.ok{color:var(--ok);border-color:var(--ok)}.tag.warn{color:var(--warn);border-color:var(--warn)}.tag.bad{color:var(--bad);border-color:var(--bad)}
.ok-text{color:var(--ok)}.warn-text{color:var(--warn)}.bad-text{color:var(--bad)}
.big{font-size:24px;font-weight:700;font-variant-numeric:tabular-nums}
.stat{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:12px 14px}.stat .big{display:block;margin-top:2px}
.toc{display:flex;gap:6px 14px;flex-wrap:wrap;font-size:14px;margin:8px 0 4px}
.media-grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(200px,1fr))}
.shot img,.shot video,.cast img{width:100%;aspect-ratio:9/16;object-fit:cover;border-radius:6px;background:var(--sunken);display:block}
.cast img{aspect-ratio:3/4}
.player{max-width:360px}.player video{width:100%;aspect-ratio:9/16;background:#000;border-radius:var(--radius);display:block}
form.calc{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));align-items:end}
form.calc input,form.calc select{width:100%}
footer{max-width:980px;margin:0 auto;padding:24px 16px;color:var(--text-2);font-size:13px;border-top:1px solid var(--border)}
footer nav{display:flex;gap:6px 14px;flex-wrap:wrap;margin-top:6px}
main.bleed{max-width:none;padding:0}
body.bleed header.top{background:var(--plum);border-bottom-color:transparent}body.bleed header.top .brand,body.bleed header.top>a{color:#fff}body.bleed header.top nav a{color:#D9CCE8}body.bleed header.top nav a:hover{color:#fff}
:focus-visible{outline:3px solid var(--gold);outline-offset:2px}
@media (max-width:600px){.hero h1{font-size:30px}h1{font-size:32px}}
`;

export function Layout(props: { title: string; user?: SessionUser | null; children: Child; description?: string; fullBleed?: boolean }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title === "Dropisode" ? "Dropisode" : `${props.title} | Dropisode`}</title>
        {props.description ? <meta name="description" content={props.description} /> : null}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@600;700;800;900&family=Public+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
      </head>
      <body class={props.fullBleed ? "bleed" : undefined}>
        <header class="top">
          <a class="brand" href="/">
            Dropisode
          </a>
          <nav>
            <a href="/pricing">Pricing</a>
            <a href="/finances">Finances</a>
            <a href="/demo">Demo</a>
            <a href="/docs">Docs</a>
          </nav>
          {props.user ? (
            <nav class="user">
              <a href="/studio/">Studio</a>
              <a href="/billing">Billing</a>
              <a href="/account">Account</a>
            </nav>
          ) : (
            <a href="/sign-in">Sign in</a>
          )}
        </header>
        {props.fullBleed ? <main class="bleed">{props.children}</main> : <main>{props.children}</main>}
        <footer>
          Dropisode is open source (MIT). Prices are the provider's price plus 20%, shown before every generation.
          <nav>
            <a href="/pricing">Pricing</a>
            <a href="/finances">Finances</a>
            <a href="/docs">Docs</a>
            <a href="/docs/local">Run it locally</a>
            <a href="/terms">Terms</a>
            <a href="/aup">Acceptable use</a>
            <a href="/privacy">Privacy</a>
            <a href="/report">Report abuse</a>
          </nav>
        </footer>
      </body>
    </html>
  );
}
