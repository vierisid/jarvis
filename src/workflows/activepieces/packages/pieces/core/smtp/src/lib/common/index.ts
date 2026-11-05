import nodemailer from 'nodemailer';
import { isIP } from 'node:net';
// Jarvis (#961): the workflow egress guard.
import { egressPolicyFromEnv, resolveGuardedAddress } from '../../../../../../../../runtime/http-egress';

export const smtpCommon = {
  constructConfig(auth: smtpAuthParams) {
    const hasCredentials = auth.email && auth.password;
    return {
      host: auth.host,
      port: auth.port,
      requireTLS: auth.TLS,
      ...(hasCredentials
        ? { auth: { user: auth.email, pass: auth.password } }
        : {}),
      connectionTimeout: 60000,
      secure: auth.port === 465,
    };
  },
  // === JARVIS PATCH (#961): the mail server passes the egress guard ===
  // The host is resolved once, every address is checked against this
  // install's policy, and nodemailer connects to the checked address, never
  // resolving the name itself. The name stays the TLS servername, so the
  // certificate is still checked against it.
  async createSMTPTransport(auth: smtpAuthParams) {
    const smtpOptions = smtpCommon.constructConfig(auth);
    const host = String(auth.host ?? '').trim();
    const address = await resolveGuardedAddress(host, egressPolicyFromEnv(), { label: 'SMTP connection' });
    const transporter = nodemailer.createTransport({
      ...smtpOptions,
      host: address,
      ...(isIP(host.replace(/^\[(.*)\]$/u, '$1')) === 0 ? { servername: host } : {}),
    }, {
      // Message defaults: nothing in a message may make nodemailer read a
      // local file or fetch a URL (an attachment or html given as { path }).
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    return transporter;
  },
  // === END JARVIS PATCH ===
};

export type smtpAuthParams = {
  host: string;
  email?: string;
  password?: string;
  port: number;
  TLS: boolean;
};
