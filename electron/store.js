// Tiny JSON store in userData: chats, pending reminders, settings. Writes are debounced and atomic.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const id = () => crypto.randomBytes(8).toString('hex');
const plain = (t) => String(t).replace(/```[\s\S]*?```/g, ' ').replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim();

class Store {
  constructor(dir) {
    this.file = path.join(dir, 'may-attacker.json');
    this.data = { chats: [], reminders: [], settings: {} };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { ...this.data, ...raw };
    } catch (_) { /* first run */ }
    // anything that was live when the app quit is over now
    for (const c of this.data.chats) {
      for (const m of c.messages) {
        if (m.streaming) m.streaming = false;
        if (m.role === 'tool' && ['pending', 'approval', 'running'].includes(m.status)) m.status = 'stopped';
      }
    }
    this.timer = null;
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 250);
  }
  flush() {
    clearTimeout(this.timer);
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }

  summaries() {
    return [...this.data.chats]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((c) => {
        const last = [...c.messages].reverse().find((m) => m.role !== 'notice') || null;
        return { id: c.id, title: c.title, updatedAt: c.updatedAt, unread: !!c.unread, snippet: last ? (last.role === 'tool' ? `$ ${last.command}` : plain(last.text)).slice(0, 80) : '' };
      });
  }
  chat(cid) { return this.data.chats.find((c) => c.id === cid) || null; }
  createChat() {
    const now = Date.now();
    const c = { id: id(), title: 'New chat', createdAt: now, updatedAt: now, unread: false, messages: [], native: { claude: [], deepseek: [] }, seen: { claude: 0, deepseek: 0 } };
    this.data.chats.push(c);
    this.save();
    return c;
  }
  deleteChat(cid) {
    this.data.chats = this.data.chats.filter((c) => c.id !== cid);
    this.data.reminders = this.data.reminders.filter((r) => r.chatId !== cid);
    this.save();
  }
  addMessage(c, msg) {
    const m = { id: id(), ts: Date.now(), ...msg };
    c.messages.push(m);
    c.updatedAt = m.ts;
    this.save();
    return m;
  }
}

module.exports = { Store, id };
