/** @jsxImportSource hono/jsx */
import type { Child } from "hono/jsx";
import type { Ctx } from "../../context";
import { page } from "../ui";

const OPERATOR = "[OPERATOR NAME AND ADDRESS]";
const SUPPORT = "[SUPPORT EMAIL]";
const UPDATED = "2026-10-29";

const Draft = () => (
  <p class="notice strong">
    <strong>Draft: to be reviewed before launch.</strong> This is a plain-language draft. It is not yet in force and has not been checked by
    a lawyer.
  </p>
);

function legal(c: Ctx, title: string, description: string, body: Child) {
  return page(c, {
    title,
    description,
    body: (
      <>
        <h1>{title}</h1>
        <Draft />
        <p class="small muted">Last updated {UPDATED}.</p>
        {body}
      </>
    ),
  });
}

export function termsPage(c: Ctx) {
  const { platform } = c.get("deps");
  const markupPct = Math.round(platform.markup * 100);
  return legal(
    c,
    "Terms of service",
    "Reel's terms of service: who can use it, what you may not make, prepaid credit and refunds.",
    <>
      <h2>Who we are</h2>
      <p>
        Reel is run by {OPERATOR} ("we"). You can reach us at {SUPPORT}. These terms cover the hosted service at this website. The
        open-source software you run yourself is covered by its MIT licence instead.
      </p>

      <h2>Who can use Reel</h2>
      <ul>
        <li>You must be 18 or over. Our model provider, fal.ai, requires every end user to be an adult.</li>
        <li>You must give a real email address and keep your sign-in secure. You are responsible for what happens in your workspace.</li>
        <li>If you use Reel for a company, you confirm you may accept these terms for it.</li>
      </ul>

      <h2>What you may not make</h2>
      <p>
        You must follow our <a href="/aup">acceptable use policy</a>. In short, you may not use Reel to make, upload or share:
      </p>
      <ul>
        <li>Content that impersonates a real person, or presents them as saying or doing something they did not.</li>
        <li>Sexual content of any real person, or intimate images of anyone without their consent.</li>
        <li>Any content involving minors in a sexual context. We report this to the authorities.</li>
        <li>Harassment, threats, or content meant to bully or intimidate anyone.</li>
        <li>Illegal content, or content that infringes someone else's rights.</li>
      </ul>
      <p>
        We check prompts, scripts and uploaded images before anything is generated, and samples of generated output after. We may block a
        generation, hide media, or freeze a workspace that breaks these rules. Blocked generations are not charged.
      </p>

      <h2>AI-generated output</h2>
      <ul>
        <li>Everything Reel generates is made by AI models. It can be wrong, strange or unlike what you asked for.</li>
        <li>
          You must label output as AI-generated wherever the law requires it, and wherever a platform you publish on requires it. Some model
          providers also require their own label.
        </li>
        <li>
          As between you and us, you own what you make, subject to the model providers' terms. You are responsible for how you use it and
          for having the rights to anything you upload.
        </li>
      </ul>

      <h2>Prices, credit and refunds</h2>
      <ul>
        <li>
          Reel is prepaid. You top up your balance (minimum ${platform.minTopupUsd}) and generations are paid from it. There is no
          subscription and no free tier.
        </li>
        <li>Each generation costs what the provider billed us, plus {markupPct}%. You see the estimate before each one.</li>
        <li>A daily charge covers your storage and a capped share of our fixed costs. It is explained on the pricing page.</li>
        <li>Credit does not expire.</li>
        <li>
          If a generation fails and the provider does not bill us, the amount held for it comes back to you automatically. If the provider
          bills a failure, we charge it and say so. A clip that renders but isn't what you wanted is not a failure.
        </li>
        <li>
          You can ask for a refund of your unused credit at any time by writing to {SUPPORT}. We refund it to your card, minus the payment
          fees we paid on those top-ups.
        </li>
        <li>
          If your balance reaches zero, new generations stop. Nothing is deleted straight away; storage keeps accruing and we email you
          before any data action.
        </li>
      </ul>

      <h2>Your data</h2>
      <p>
        How we handle your data is in our <a href="/privacy">privacy notice</a>. You can export any project at any time.
      </p>

      <h2>Ending your use</h2>
      <p>
        You can stop using Reel at any time and ask for your unused credit back. We may suspend or close an account that breaks these terms,
        after telling you why unless the law or safety prevents it.
      </p>

      <h2>Our liability</h2>
      <p>
        We provide Reel as it is. We do our best to keep it running and your data safe, but we can't promise it will always be available or
        that every generation will succeed. As far as the law allows, our liability to you is limited to the amount you paid us in the 12
        months before the claim. Nothing here limits liability that the law does not allow us to limit.
      </p>

      <h2>Changes</h2>
      <p>We will tell you by email before material changes to these terms take effect.</p>
    </>,
  );
}

export function aupPage(c: Ctx) {
  return legal(
    c,
    "Acceptable use policy",
    "What you may not make or upload with Reel, and what happens if you do.",
    <>
      <p>
        This policy is part of our <a href="/terms">terms</a>. It applies to prompts, scripts, character names, uploaded images and
        everything generated.
      </p>

      <h2>Never allowed</h2>
      <ul>
        <li>
          <strong>Minors:</strong> any sexual or sexualised content involving anyone under 18, or anyone who looks under 18. We block it,
          keep a record and report it.
        </li>
        <li>
          <strong>Real people:</strong> sexual content of any real person, and intimate imagery of anyone without consent.
        </li>
        <li>
          <strong>Impersonation:</strong> content that pretends to be a real person, or shows them saying or doing things they did not, in a
          way that could mislead. Names of well-known public figures are blocked in prompts and character names.
        </li>
        <li>
          <strong>Harassment:</strong> content targeting a person to bully, threaten, shame or intimidate them.
        </li>
        <li>
          <strong>Illegal content:</strong> anything illegal where you or we are, including content that promotes terrorism or violent
          extremism, and content that infringes copyright or trademarks.
        </li>
        <li>
          <strong>Deception:</strong> fake news footage, fraud, or election content meant to mislead.
        </li>
      </ul>

      <h2>Photos of real people</h2>
      <p>
        You may upload a reference photo of a real person only if you have their consent to use it this way. You confirm this when you
        upload. Never upload photos of children as references.
      </p>

      <h2>Labelling</h2>
      <p>
        Label what you publish as AI-generated where the law or the platform requires it. Don't remove labels or watermarks a model provider
        adds.
      </p>

      <h2>Abuse of the service</h2>
      <ul>
        <li>No payment fraud, stolen cards, or chargebacks after using credit.</li>
        <li>No attempts to get around moderation, spending limits or another workspace's access.</li>
        <li>No reselling access to Reel as your own service.</li>
      </ul>

      <h2>What we do</h2>
      <ul>
        <li>We check prompts, scripts and uploads before any money is spent, and sample generated frames afterwards.</li>
        <li>A blocked request costs you nothing. A hit on generated output hides that media and flags the workspace for review.</li>
        <li>We may freeze a workspace while we review it, and close accounts that break this policy.</li>
        <li>Every admin action is logged.</li>
      </ul>

      <h2>Reporting</h2>
      <p>
        Seen something made with Reel that breaks these rules? Use the <a href="/report">abuse report form</a> or write to {SUPPORT}.
      </p>
    </>,
  );
}

export function privacyPage(c: Ctx) {
  return legal(
    c,
    "Privacy notice",
    "What personal data Reel collects, why, who processes it, and your rights.",
    <>
      <h2>Who is responsible</h2>
      <p>
        {OPERATOR} is responsible for your personal data on the hosted service. Contact: {SUPPORT}.
      </p>

      <h2>What we collect and why</h2>
      <ul>
        <li>
          <strong>Account:</strong> your email address, name, and the account id from Google or GitHub if you sign in with them. To sign you
          in and contact you about your account and balance.
        </li>
        <li>
          <strong>Your projects:</strong> scripts, prompts, cast descriptions, uploaded images and generated media. To run the studio for
          you.
        </li>
        <li>
          <strong>Billing:</strong> top-ups, charges, holds and refunds. To keep your balance and our published accounts correct. Card
          details go to Stripe; we never see your card number.
        </li>
        <li>
          <strong>Safety:</strong> moderation results, blocked attempts and abuse reports. To keep the service safe and meet our providers'
          terms.
        </li>
        <li>
          <strong>Technical:</strong> a sign-in cookie, and server logs with IP addresses. To keep you signed in and protect the service. We
          don't use advertising cookies.
        </li>
      </ul>

      <h2>Who processes it for us</h2>
      <ul>
        <li>fal.ai and the model providers it routes to: the prompts, images and text needed for each generation.</li>
        <li>OpenAI's moderation API: prompts, script excerpts and images, checked before generation.</li>
        <li>Stripe: payments.</li>
        <li>Cloudflare R2: storage for media files.</li>
        <li>Our email provider: sign-in links and account emails.</li>
        <li>Our server host: the database and application.</li>
      </ul>
      <p>Some of these are outside your country. We rely on their standard data protection terms for those transfers.</p>

      <h2>How long we keep it</h2>
      <ul>
        <li>Projects and media: until you delete them or close your account. [RETENTION FOR UNPAID STORAGE: owner decision]</li>
        <li>Billing records: as long as tax law requires.</li>
        <li>Moderation records of blocked attempts: [PERIOD], longer where we must report them.</li>
      </ul>

      <h2>Your rights</h2>
      <p>
        You can ask for a copy of your data, ask us to correct or delete it, or object to how we use it. Export any project from the studio
        yourself at any time. Write to {SUPPORT}. You can also complain to your data protection authority.
      </p>

      <h2>Local mode</h2>
      <p>
        If you run Reel on your own computer, we receive nothing. Your projects stay on your disk and your requests go straight to fal.ai
        under your own account.
      </p>
    </>,
  );
}
