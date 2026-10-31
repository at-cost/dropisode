/** @jsxImportSource hono/jsx */
/** The shared page shell for every server-rendered page (site, sign-in, account, billing, admin). */
import type { Child } from "hono/jsx";
import type { SessionUser } from "../context";

export const CSS = `
:root{color-scheme:light;--bg:#F4F2FA;--surface:#fff;--sunken:#EAE6F3;--border:#D9D3E6;--text:#191322;--text-2:#5A5266;--accent:#C2214F;--accent-text:#fff;--plum:#1D0F2B;--plum-2:#2B1840;--rouge:#E5336A;--gold:#F4C24E;--ok:#2f6b3a;--warn:#9a5b00;--bad:#a12a2a;--radius:10px;--display:"Big Shoulders Display","Arial Narrow",sans-serif;--font:"Public Sans",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#140B1E;--surface:#1E1329;--sunken:#2A1C38;--border:#3B2B4D;--text:#F2EEF8;--text-2:#B9AECA;--accent:#F2517F;--accent-text:#1A0710;--ok:#7fc48a;--warn:#e0a84a;--bad:#ef8a8a}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 var(--font)}
a{color:var(--accent)}main{max-width:1100px;margin:0 auto;padding:24px 16px 64px}
header.top{background:var(--plum);color:#fff;position:relative;z-index:20}
.top-in{max-width:1100px;margin:0 auto;display:flex;gap:10px 22px;align-items:center;padding:12px 20px}
header.top .brand{font-family:var(--display);font-weight:800;font-size:26px;line-height:1;color:#fff;text-decoration:none;letter-spacing:.01em}
.main-nav{display:flex;gap:4px;flex:1}.main-nav a{color:#D9CCE8;text-decoration:none;padding:6px 12px;border-radius:999px;font-size:15px;font-weight:500}
.main-nav a:hover{color:#fff;background:rgba(255,255,255,.07)}.main-nav a[aria-current=page]{color:#fff;background:rgba(255,255,255,.12)}
.signin-link{color:#D9CCE8;text-decoration:none;font-weight:500;font-size:15px}.signin-link:hover{color:#fff}
.nav-menu{display:none;position:relative}.nav-menu summary{list-style:none;cursor:pointer;width:40px;height:40px;border-radius:10px;display:grid;place-content:center;gap:4px;background:rgba(255,255,255,.08)}
.nav-menu summary::-webkit-details-marker{display:none}.nav-menu summary span{display:block;width:18px;height:2px;border-radius:2px;background:#fff}
.nav-menu nav{position:absolute;right:0;top:calc(100% + 10px);min-width:200px;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:6px;box-shadow:0 18px 40px rgba(20,8,30,.3);display:flex;flex-direction:column}
.nav-menu nav a{color:var(--text);text-decoration:none;padding:10px 12px;border-radius:8px}.nav-menu nav a:hover{background:var(--sunken)}
@media (max-width:720px){.main-nav,.signin-link,.user-area .studio-btn[href="/studio/"]{display:none}.nav-menu{display:block}.top-in{padding:10px 14px;gap:10px}.user-area{margin-left:auto}}
.user-area{display:flex;align-items:center;gap:16px;margin-left:auto}
.studio-btn{font-weight:600;font-size:14px;text-decoration:none;color:#fff;background:var(--rouge);border-radius:999px;padding:8px 16px;white-space:nowrap}
.studio-btn:hover{filter:brightness(1.08)}
.profile{position:relative}.profile summary{list-style:none;cursor:pointer;border-radius:50%;display:block}.profile summary::-webkit-details-marker{display:none}
.avatar{display:grid;place-items:center;width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,var(--rouge),var(--gold));color:#1D0F2B;font-family:var(--display);font-weight:800;font-size:18px;box-shadow:0 0 0 2px var(--plum),0 0 0 3px #4a3360}
.profile[open] .avatar,.profile summary:hover .avatar{box-shadow:0 0 0 2px var(--plum),0 0 0 3px var(--gold)}
.profile .menu{position:absolute;right:0;top:calc(100% + 12px);z-index:50;color:var(--text);min-width:250px;background:var(--surface);border:1px solid var(--border);border-radius:12px;box-shadow:0 18px 40px rgba(20,8,30,.3);padding:6px;display:flex;flex-direction:column}
.profile .who{padding:10px 12px 12px;border-bottom:1px solid var(--border);margin-bottom:6px;display:flex;flex-direction:column;gap:2px;min-width:0}
.profile .who strong{color:var(--text)}.profile .who span{color:var(--text-2);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.profile .menu a,.profile .menu .signout{display:block;width:100%;text-align:left;padding:9px 12px;border-radius:8px;color:var(--text);text-decoration:none;font-size:14px;background:none;border:0;font-weight:500}
.profile .menu a:hover,.profile .menu .signout:hover{background:var(--sunken)}
.profile .menu form{margin:6px 0 0;padding-top:6px;border-top:1px solid var(--border)}.profile .menu .signout{color:var(--accent)}
body.auth{background:radial-gradient(90% 70% at 85% 0%,rgba(244,194,78,.18),transparent 60%),radial-gradient(80% 70% at 0% 100%,rgba(229,51,106,.28),transparent 60%),var(--plum);min-height:100vh}
body.auth main{max-width:none;display:grid;place-items:start center;padding:56px 16px 72px}
body.auth main>.narrow{width:min(440px,100%);background:var(--surface);border-radius:20px;padding:30px 28px;box-shadow:0 30px 80px rgba(0,0,0,.35)}
body.auth main>.narrow h1{font-size:40px;margin:0 0 6px}body.auth main>.narrow .card{border:0;padding:0;background:none}
body.auth main>.narrow input{width:100%;padding:10px 12px}body.auth main>.narrow button[type=submit],body.auth main>.narrow .button{width:100%;padding:11px 14px;font-weight:600;border-radius:10px}
body.auth footer{color:#B9AECA;border-top-color:rgba(255,255,255,.1)}body.auth footer a{color:#D9CCE8}
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
select{appearance:none;-webkit-appearance:none;padding-right:34px;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' fill='none' stroke='%23B9AECA' stroke-width='1.8'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 12px center}
form.calc input,form.calc select{height:42px}form.calc{grid-template-columns:repeat(auto-fit,minmax(200px,1fr))}
.sm-only{display:none}
@media (max-width:640px){.sm-hide{display:none}.sm-only{display:block}.table-wrap table.fit-sm,.scroll table.fit-sm{min-width:0}}
details.fold{border:1px solid var(--border);border-radius:var(--radius);background:var(--surface);margin:18px 0;padding:0 18px}
details.fold>summary{cursor:pointer;list-style:none;display:flex;align-items:center;justify-content:space-between;padding:14px 0}
details.fold>summary::-webkit-details-marker{display:none}details.fold>summary h2{margin:0;font-size:24px}
details.fold>summary::after{content:"+";font-size:26px;color:var(--accent);font-weight:600}details.fold[open]>summary::after{content:"\\2212"}
details.fold[open]{padding-bottom:16px}
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
.big{font-family:var(--display);font-size:34px;font-weight:800;line-height:1.1;font-variant-numeric:tabular-nums}
.stat{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:12px 14px}.stat .big{display:block;margin-top:2px}
.toc{display:flex;gap:6px;flex-wrap:wrap;font-size:14px;margin:12px 0 8px;position:sticky;top:0;z-index:5;background:var(--bg);padding:10px 0}
.toc a{text-decoration:none;color:var(--text-2);border:1px solid var(--border);border-radius:999px;padding:5px 12px;background:var(--surface)}.toc a:hover{color:var(--text);border-color:var(--accent)}
.shots-grid{grid-template-columns:repeat(6,minmax(0,1fr))}@media (max-width:1000px){.shots-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}@media (max-width:520px){.shots-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
body.auth{display:flex;flex-direction:column}body.auth main{flex:1}
.media-grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(200px,1fr))}
.shot img,.shot video,.cast img{width:100%;aspect-ratio:9/16;object-fit:cover;border-radius:6px;background:var(--sunken);display:block}
.cast img{aspect-ratio:3/4}
.player{max-width:360px}.player video{width:100%;aspect-ratio:9/16;background:#000;border-radius:var(--radius);display:block}
form.calc{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));align-items:end}
form.calc input,form.calc select{width:100%}
footer{max-width:1100px;margin:0 auto;padding:24px 16px;color:var(--text-2);font-size:13px;border-top:1px solid var(--border)}
footer nav{display:flex;gap:6px 14px;flex-wrap:wrap;margin-top:6px}
main.bleed{max-width:none;padding:0}

:focus-visible{outline:3px solid var(--gold);outline-offset:2px}
@media (max-width:600px){.hero h1{font-size:30px}h1{font-size:32px}}
`;

/** Two letters from a name or email, for the avatar. */
export function initials(name: string, email: string): string {
  const words = (name || email.split("@")[0] || "?")
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .trim()
    .split(/\s+/);
  const two = words.length > 1 ? words[0]![0]! + words[words.length - 1]![0]! : (words[0] ?? "?").slice(0, 1);
  return two.toUpperCase();
}

/** Avatar button with a menu (a <details>, so it works without JavaScript). */
function ProfileMenu(props: { user: SessionUser }) {
  const u = props.user;
  return (
    <details class="profile">
      <summary aria-label="Your account menu">
        <span class="avatar" aria-hidden="true">
          {initials(u.name, u.email)}
        </span>
      </summary>
      <div class="menu" role="menu">
        <div class="who">
          <strong>{u.name}</strong>
          <span>{u.email}</span>
        </div>
        <a href="/studio/" role="menuitem">
          Studio
        </a>
        <a href="/billing" role="menuitem">
          Billing and credit
        </a>
        <a href="/account" role="menuitem">
          Account and team
        </a>
        {u.isAdmin ? (
          <a href="/admin" role="menuitem">
            Admin
          </a>
        ) : null}
        <form method="post" action="/auth/sign-out">
          <button type="submit" class="signout" role="menuitem">
            Sign out
          </button>
        </form>
      </div>
    </details>
  );
}

const NAV: [string, string][] = [
  ["/demo", "Demo"],
  ["/pricing", "Pricing"],
  ["/finances", "Finances"],
  ["/docs", "Docs"],
];

export function Layout(props: {
  title: string;
  user?: SessionUser | null;
  children: Child;
  description?: string;
  fullBleed?: boolean;
  /** The request path, to mark the current page in the nav. */
  path?: string;
  /** "auth": a centred card on the plum backdrop (sign-in, sign-up and friends). */
  variant?: "auth";
}) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title === "Dropisode" ? "Dropisode" : `${props.title} | Dropisode`}</title>
        {props.description ? <meta name="description" content={props.description} /> : null}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@600;700;800;900&family=Public+Sans:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
      </head>
      <body class={[props.fullBleed ? "bleed" : "", props.variant === "auth" ? "auth" : ""].filter(Boolean).join(" ") || undefined}>
        <header class="top">
          <div class="top-in">
            <a class="brand" href="/">
              Dropisode
            </a>
            <nav class="main-nav" aria-label="Site">
              {NAV.map(([href, label]) => (
                <a href={href} aria-current={props.path?.startsWith(href) ? "page" : undefined}>
                  {label}
                </a>
              ))}
            </nav>
            {props.user ? (
              <div class="user-area">
                <a class="studio-btn" href="/studio/">
                  Open studio
                </a>
                <ProfileMenu user={props.user} />
              </div>
            ) : (
              <div class="user-area">
                {props.path === "/sign-in" ? null : (
                  <a class="signin-link" href="/sign-in">
                    Sign in
                  </a>
                )}
                {props.path === "/sign-up" ? null : (
                  <a class="studio-btn" href="/sign-up">
                    Sign up
                  </a>
                )}
              </div>
            )}
            <details class="nav-menu">
              <summary aria-label="Menu">
                <span />
                <span />
                <span />
              </summary>
              <nav aria-label="Site menu">
                {NAV.map(([href, label]) => (
                  <a href={href}>{label}</a>
                ))}
                {props.user ? null : <a href="/sign-in">Sign in</a>}
              </nav>
            </details>
          </div>
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
        <script
          dangerouslySetInnerHTML={{
            __html: `document.addEventListener("click",e=>{for(const d of document.querySelectorAll("details.profile[open],details.nav-menu[open]"))if(!d.contains(e.target))d.open=false});document.addEventListener("keydown",e=>{if(e.key==="Escape")for(const d of document.querySelectorAll("details.profile[open],details.nav-menu[open]"))d.open=false});`,
          }}
        />
      </body>
    </html>
  );
}
