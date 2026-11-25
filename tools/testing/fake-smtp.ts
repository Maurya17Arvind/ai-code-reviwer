import { type AddressInfo, createServer, type Server, type Socket } from 'node:net';

/**
 * Minimal SMTP server on 127.0.0.1 for tests (ADR-040). Speaks enough RFC 5321 for nodemailer:
 * EHLO/HELO, optional AUTH PLAIN, MAIL FROM, RCPT TO, DATA (with dot-unstuffing), RSET, NOOP, QUIT.
 * No TLS. Received messages are decoded far enough for tests to read the subject, plain text and HTML
 * and follow links. Recipients can be scripted to be rejected with any reply code.
 */
export interface ReceivedMail {
  readonly from: string;
  readonly to: readonly string[];
  readonly raw: string;
  readonly headers: ReadonlyMap<string, string>;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export interface FakeSmtpOptions {
  /** When set, AUTH PLAIN is advertised and required with exactly these credentials. */
  readonly credentials?: { readonly user: string; readonly pass: string };
}

export class FakeSmtpServer {
  readonly messages: ReceivedMail[] = [];
  /** Recipient address (lower case) → reply line to RCPT TO, e.g. `550 5.1.1 No such user`. */
  readonly rejectRecipients = new Map<string, string>();
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();

  constructor(private readonly options: FakeSmtpOptions = {}) {}

  async start(): Promise<number> {
    this.server = createServer((socket) => this.handle(socket));
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    return (this.server?.address() as AddressInfo).port;
  }

  /** `smtp://[user:pass@]127.0.0.1:<port>` for the running server. */
  url(): string {
    const port = (this.server?.address() as AddressInfo | null)?.port;
    if (!port) throw new Error('FakeSmtpServer is not started');
    const auth = this.options.credentials
      ? `${encodeURIComponent(this.options.credentials.user)}:${encodeURIComponent(this.options.credentials.pass)}@`
      : '';
    return `smtp://${auth}127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }

  /** Messages delivered to one address, oldest first. */
  to(address: string): ReceivedMail[] {
    return this.messages.filter((m) => m.to.includes(address.toLowerCase()));
  }

  private handle(socket: Socket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.setEncoding('utf8');
    const reply = (line: string) => socket.write(`${line}\r\n`);

    let buffer = '';
    let authenticated = !this.options.credentials;
    let from = '';
    let to: string[] = [];
    let data: string[] | null = null;

    reply('220 fake-smtp ESMTP ready');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);

        if (data) {
          if (line === '.') {
            const raw = data.join('\r\n');
            this.messages.push(parseMessage(from, to, raw));
            data = null;
            from = '';
            to = [];
            reply('250 2.0.0 Message accepted');
          } else {
            data.push(line.startsWith('..') ? line.slice(1) : line);
          }
          continue;
        }

        const [verb = '', ...rest] = line.split(' ');
        const argument = rest.join(' ');
        switch (verb.toUpperCase()) {
          case 'EHLO':
            reply('250-fake-smtp');
            if (this.options.credentials) reply('250-AUTH PLAIN');
            reply('250 8BITMIME');
            break;
          case 'HELO':
            reply('250 fake-smtp');
            break;
          case 'AUTH': {
            const [mechanism, initial] = argument.split(' ');
            const decoded = Buffer.from(initial ?? '', 'base64')
              .toString('utf8')
              .split('\u0000');
            const ok =
              mechanism?.toUpperCase() === 'PLAIN' &&
              decoded[1] === this.options.credentials?.user &&
              decoded[2] === this.options.credentials?.pass;
            authenticated = ok;
            reply(ok ? '235 2.7.0 Authentication successful' : '535 5.7.8 Authentication credentials invalid');
            break;
          }
          case 'MAIL':
            if (!authenticated) {
              reply('530 5.7.0 Authentication required');
              break;
            }
            from = addressOf(argument);
            to = [];
            reply('250 2.1.0 OK');
            break;
          case 'RCPT': {
            const recipient = addressOf(argument).toLowerCase();
            const rejection = this.rejectRecipients.get(recipient);
            if (rejection) {
              reply(rejection);
            } else {
              to.push(recipient);
              reply('250 2.1.5 OK');
            }
            break;
          }
          case 'DATA':
            if (to.length === 0) {
              reply('554 5.5.1 No valid recipients');
              break;
            }
            data = [];
            reply('354 End data with <CR><LF>.<CR><LF>');
            break;
          case 'RSET':
            from = '';
            to = [];
            reply('250 2.0.0 OK');
            break;
          case 'NOOP':
            reply('250 2.0.0 OK');
            break;
          case 'QUIT':
            reply('221 2.0.0 Bye');
            socket.end();
            break;
          default:
            reply('502 5.5.2 Command not implemented');
        }
      }
    });
  }
}

function addressOf(argument: string): string {
  return /<([^>]*)>/.exec(argument)?.[1] ?? '';
}

function parseHeaders(block: string): Map<string, string> {
  const headers = new Map<string, string>();
  // Unfold continuation lines, then split "Name: value".
  for (const line of block.replace(/\r\n[ \t]+/g, ' ').split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return headers;
}

function splitEntity(entity: string): { headers: Map<string, string>; body: string } {
  const end = entity.indexOf('\r\n\r\n');
  return end < 0
    ? { headers: parseHeaders(entity), body: '' }
    : { headers: parseHeaders(entity.slice(0, end)), body: entity.slice(end + 4) };
}

function decodeQuotedPrintable(body: string): string {
  const bytes: number[] = [];
  const text = body.replace(/=\r\n/g, '');
  for (let i = 0; i < text.length; i++) {
    const hex = text.slice(i + 1, i + 3);
    if (text[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(...Buffer.from(text[i] ?? '', 'utf8'));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function decodeBody(headers: Map<string, string>, body: string): string {
  const encoding = (headers.get('content-transfer-encoding') ?? '7bit').toLowerCase();
  if (encoding === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  if (encoding === 'quoted-printable') return decodeQuotedPrintable(body);
  return body;
}

/** RFC 2047 encoded words in headers, e.g. `=?UTF-8?Q?...?=`. */
function decodeHeaderValue(value: string): string {
  return value.replace(
    /=\?([^?]+)\?([BQbq])\?([^?]*)\?=\s*/g,
    (_match, _charset: string, kind: string, text: string) =>
      kind.toUpperCase() === 'B'
        ? Buffer.from(text, 'base64').toString('utf8')
        : decodeQuotedPrintable(text.replace(/_/g, ' ')),
  );
}

function parseMessage(from: string, to: readonly string[], raw: string): ReceivedMail {
  const { headers, body } = splitEntity(raw);
  let text = '';
  let html = '';
  const collect = (entityHeaders: Map<string, string>, entityBody: string) => {
    const type = (entityHeaders.get('content-type') ?? 'text/plain').toLowerCase();
    const boundary = /boundary="?([^";]+)"?/i.exec(entityHeaders.get('content-type') ?? '')?.[1];
    if (type.startsWith('multipart/') && boundary) {
      for (const part of entityBody.split(`--${boundary}`).slice(1)) {
        if (part.startsWith('--')) break;
        const entity = splitEntity(part.replace(/^\r\n/, ''));
        collect(entity.headers, entity.body);
      }
    } else if (type.startsWith('text/html')) {
      html = decodeBody(entityHeaders, entityBody);
    } else if (type.startsWith('text/plain')) {
      text = decodeBody(entityHeaders, entityBody);
    }
  };
  collect(headers, body);
  return {
    from,
    to,
    raw,
    headers,
    subject: decodeHeaderValue(headers.get('subject') ?? ''),
    text: text.replace(/\r\n/g, '\n').trimEnd(),
    html,
  };
}
