/** Keep enough raw tail to prevent a credential split across stream chunks from escaping. */
export class SecretRedactor {
  private pending = '';
  private secrets: string[];
  constructor(values: string[]) { this.secrets = [...new Set(values.filter(Boolean))].sort((a, b) => b.length - a.length); }
  text(value: string) { for (const secret of this.secrets) value = value.split(secret).join('[REDACTED]'); return value; }
  push(value: string) {
    this.pending += value;
    let cut = Math.max(0, this.pending.length - Math.max(0, ...this.secrets.map(s => s.length - 1)));
    for (const secret of this.secrets) {
      let index = this.pending.indexOf(secret);
      while (index >= 0) { if (index < cut && index + secret.length > cut) cut = index; index = this.pending.indexOf(secret, index + 1); }
    }
    const output = this.text(this.pending.slice(0, cut)); this.pending = this.pending.slice(cut); return output;
  }
  finish() { const output = this.text(this.pending); this.pending = ''; return output; }
}
