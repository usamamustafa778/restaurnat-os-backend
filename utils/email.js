const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  const {
    SMTP_HOST,
    SMTP_PORT,
    SMTP_USER,
    SMTP_PASS,
  } = process.env;

  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    console.warn(
      '[email] SMTP configuration is missing. Emails will be logged to console instead of being sent.',
    );
    transporter = null;
    return null;
  }

  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: Number(SMTP_PORT) === 465,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });

  return transporter;
}

const FROM =
  process.env.EMAIL_FROM ||
  process.env.MAIL_FROM ||
  process.env.SMTP_USER ||
  'Eats Desk <no-reply@eatsdesk.com>';

async function sendEmail({ to, subject, text, html }) {
  const tx = getTransporter();

  if (!tx) {
    console.log('[email][mock]', { to, subject, text, html });
    return { sent: false, error: 'SMTP not configured' };
  }

  await tx.sendMail({
    from: FROM,
    to,
    subject,
    text,
    html: html || `<p>${text}</p>`,
  });
  return { sent: true };
}

async function sendOtpEmail(toEmail, code, label) {
  const tx = getTransporter();

  if (!process.env.SMTP_USER || !process.env.SMTP_PASS || !tx) {
    console.warn('[email] SMTP not configured (SMTP_USER/SMTP_PASS). OTP logged only:', code);
    return { sent: false, error: 'SMTP not configured' };
  }

  const appName = process.env.APP_NAME || 'Eats Desk';
  const subject = `${appName} – Your verification code is ${code}`;
  const html = `
    <div style="font-family: sans-serif; max-width: 400px; margin: 0 auto;">
      <h2 style="color: #111;">${label} – Verification code</h2>
      <p>Use this code to verify your email:</p>
      <p style="font-size: 24px; font-weight: bold; letter-spacing: 4px; color: #111;">${code}</p>
      <p style="color: #666; font-size: 14px;">This code expires in 10 minutes. If you didn't request it, you can ignore this email.</p>
      <p style="color: #666; font-size: 14px;">– ${appName}</p>
    </div>
  `;
  const text = `${appName} – Your verification code is: ${code}. It expires in 10 minutes.`;

  try {
    await tx.sendMail({
      from: FROM,
      to: toEmail,
      subject,
      text,
      html,
    });
    return { sent: true };
  } catch (err) {
    console.error('Failed to send OTP email:', err.message);
    return { sent: false, error: err.message };
  }
}

module.exports = { sendEmail, sendOtpEmail };

