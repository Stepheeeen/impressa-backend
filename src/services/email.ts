import * as Sentry from "@sentry/node";
import { Resend } from "resend";
import { env } from "../config/env";

const resend = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

// Sends a support chat the assistant couldn't resolve to the support inbox. Replying goes straight to the customer.
export async function sendSupportEscalationEmail({
  to,
  customerEmail,
  customerName,
  note,
  transcript,
}: {
  to: string;
  customerEmail: string;
  customerName: string;
  note: string;
  transcript: { role: "user" | "assistant"; text: string; at: Date }[];
}) {
  const subject = `Support request from ${customerName}`;
  const lines = transcript.map((message) => `${message.role === "user" ? customerName : "Assistant"}: ${message.text}`);
  const text = [
    `${customerName} <${customerEmail}> asked for help from the support chat. Reply to this email to answer them.`,
    note ? `\nTheir note: ${note}` : "",
    "\nConversation:\n",
    ...lines,
  ].join("\n");
  const html = `
    <div style="font-family: Arial, sans-serif; color: #0A2342; max-width: 640px;">
      <p><strong>${escapeHtml(customerName)}</strong> &lt;${escapeHtml(customerEmail)}&gt; asked for help from the support chat. Reply to this email to answer them.</p>
      ${note ? `<p><strong>Their note:</strong> ${escapeHtml(note)}</p>` : ""}
      <hr style="border: none; border-top: 1px solid #E5E5E5;" />
      ${transcript
        .map(
          (message) =>
            `<p style="margin: 8px 0;"><strong>${message.role === "user" ? escapeHtml(customerName) : "Assistant"}:</strong> ${escapeHtml(message.text).replace(/\n/g, "<br />")}</p>`
        )
        .join("")}
    </div>`;

  if (!resend) {
    console.log(`[email] Support request from ${customerEmail} to ${to}:\n${text}`);
    return;
  }

  const { error } = await resend.emails.send({ from: env.EMAIL_FROM, to, replyTo: customerEmail, subject, text, html });
  if (error) {
    Sentry.captureMessage(`Support escalation email from ${customerEmail} failed: ${error.message}`, "error");
    throw new Error(`Resend rejected the email: ${error.message}`);
  }
}

export async function sendPasswordResetEmail(to: string, resetUrl: string) {
  const subject = "Reset your Impressa password";
  const text = [
    "We received a request to reset the password for your Impressa account.",
    "",
    `Reset your password: ${resetUrl}`,
    "",
    "This link expires in 30 minutes and can only be used once.",
    "If you didn't ask for this, you can ignore this email. Your password won't change.",
  ].join("\n");
  const html = `
    <div style="font-family: Arial, sans-serif; color: #0A2342; max-width: 480px;">
      <p style="font-size: 20px; letter-spacing: 4px;">IMPRESSA</p>
      <p>We received a request to reset the password for your Impressa account.</p>
      <p>
        <a href="${escapeHtml(resetUrl)}"
           style="display: inline-block; background: #800020; color: #FAF9F6; padding: 12px 20px; border-radius: 6px; text-decoration: none;">
          Reset password
        </a>
      </p>
      <p style="color: #4B5B72; font-size: 14px;">This link expires in 30 minutes and can only be used once. If you didn't ask for this, you can ignore this email.</p>
    </div>`;

  if (!resend) {
    // Production refuses to start without RESEND_API_KEY, so this only happens locally.
    console.log(`[email] Password reset link for ${to}: ${resetUrl}`);
    return;
  }

  const { error } = await resend.emails.send({ from: env.EMAIL_FROM, to, subject, text, html });
  if (error) {
    Sentry.captureMessage(`Password reset email to ${to} failed: ${error.message}`, "error");
    throw new Error(`Resend rejected the email: ${error.message}`);
  }
}
