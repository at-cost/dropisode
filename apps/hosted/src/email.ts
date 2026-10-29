/**
 * Email through SMTP (Amazon SES's SMTP endpoint in production). Without
 * SMTP_URL, emails are logged; SMTP_URL=file:///path.jsonl appends them to a
 * file (tests). Shaped after at-cost/glasstrack's email module (MIT).
 */
import { appendFileSync } from "node:fs";
import nodemailer from "nodemailer";
import type { Config } from "./config";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(msg: EmailMessage): Promise<void>;
  /** Messages sent, when the mailer keeps them (tests). */
  sent?: EmailMessage[];
}

export function createMailer(config: Config): Mailer {
  if (!config.SMTP_URL) {
    const sent: EmailMessage[] = [];
    return {
      sent,
      async send(msg) {
        sent.push(msg);
        if (config.NODE_ENV !== "test") console.log(`reel: email (SMTP_URL unset) to ${msg.to}: ${msg.subject}\n${msg.text}`);
      },
    };
  }
  if (config.SMTP_URL.startsWith("file://")) {
    const file = config.SMTP_URL.slice("file://".length);
    return {
      async send(msg) {
        appendFileSync(file, `${JSON.stringify({ ...msg, at: new Date().toISOString() })}\n`);
      },
    };
  }
  const transport = nodemailer.createTransport(config.SMTP_URL);
  return {
    async send(msg) {
      await transport.sendMail({ from: config.EMAIL_FROM, to: msg.to, subject: msg.subject, text: msg.text });
    },
  };
}
