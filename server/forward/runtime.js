// Small fallbacks for JavaScriptCore hosts without the Web API globals.
// Network access is exclusively through Widget.http, never a local server.
(function () {
  if (typeof globalThis.URLSearchParams === 'undefined') {
    globalThis.URLSearchParams = class URLSearchParams {
      constructor(input = '') {
        const decode = value => decodeURIComponent(value.replace(/\+/g, ' '));
        this.pairs = typeof input === 'string'
          ? input.replace(/^\?/, '').split('&').filter(Boolean).map(pair => {
            const at = pair.indexOf('=');
            return at < 0 ? [decode(pair), ''] : [decode(pair.slice(0, at)), decode(pair.slice(at + 1))];
          })
          : Array.isArray(input) ? input.map(pair => [...pair]) : Object.entries(input);
      }
      get(key) { return this.pairs.find(pair => pair[0] === String(key))?.[1] ?? null; }
      getAll(key) { return this.pairs.filter(pair => pair[0] === String(key)).map(pair => pair[1]); }
      has(key) { return this.pairs.some(pair => pair[0] === String(key)); }
      append(key, value) { this.pairs.push([String(key), String(value)]); }
      delete(key) { this.pairs = this.pairs.filter(pair => pair[0] !== String(key)); }
      set(key, value) { this.delete(key); this.append(key, value); }
      sort() { this.pairs.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0); }
      entries() { return this.pairs[Symbol.iterator](); }
      keys() { return this.pairs.map(pair => pair[0])[Symbol.iterator](); }
      forEach(fn) { this.pairs.forEach(pair => fn(pair[1], pair[0], this)); }
      [Symbol.iterator]() { return this.entries(); }
      toString() { return this.pairs.map(pair => pair.map(value => encodeURIComponent(String(value))).join('=')).join('&'); }
    };
  }
  if (typeof globalThis.URL === 'undefined') {
    globalThis.URL = class URL {
      constructor(input, base) {
        let text = String(input);
        if (!/^https?:\/\//i.test(text)) {
          if (!base) throw new TypeError('URL requires an HTTP(S) base');
          const parent = new URL(String(base));
          if (text.startsWith('//')) text = parent.protocol + text;
          else if (text.startsWith('?')) text = parent.origin + parent.pathname + text;
          else if (text.startsWith('#')) text = parent.origin + parent.pathname + parent.search + text;
          else text = parent.origin + (text.startsWith('/') ? text : parent.pathname.replace(/[^/]*$/, '') + text);
        }
        const match = text.match(/^(https?:)\/\/([^/?#]+)([^?#]*)(\?[^#]*)?(#.*)?$/i);
        if (!match) throw new TypeError('Invalid HTTP(S) URL');
        this.protocol = match[1];
        this.host = match[2];
        const parts = [];
        for (const part of (match[3] || '/').split('/')) {
          if (part === '..') parts.pop();
          else if (part !== '.') parts.push(part);
        }
        this.pathname = parts.join('/') || '/';
        this.search = match[4] || '';
        this.hash = match[5] || '';
      }
      get hostname() { return this.host.replace(/:\d+$/, ''); }
      get origin() { return this.protocol + '//' + this.host; }
      get search() { const text = this.searchParams.toString(); return text ? '?' + text : ''; }
      set search(value) { this.searchParams = new URLSearchParams(String(value)); }
      get href() { return this.toString(); }
      toString() { return this.origin + this.pathname + this.search + this.hash; }
    };
  }
  if (typeof globalThis.Headers === 'undefined') {
    globalThis.Headers = class Headers {
      constructor(input = {}) {
        this.values = new Map();
        const entries = typeof input.entries === 'function' ? input.entries() : Object.entries(input);
        for (const [key, value] of entries) this.set(key, value);
      }
      set(key, value) { this.values.set(String(key).toLowerCase(), String(value)); }
      get(key) { return this.values.get(String(key).toLowerCase()) ?? null; }
      forEach(fn) { this.values.forEach((value, key) => fn(value, key, this)); }
      entries() { return this.values.entries(); }
      [Symbol.iterator]() { return this.entries(); }
    };
  }
  if (typeof globalThis.Response === 'undefined') {
    globalThis.Response = class Response {
      constructor(body, options = {}) {
        this._body = body;
        this.status = options.status ?? 200;
        this.ok = this.status >= 200 && this.status < 300;
        this.headers = new Headers(options.headers);
      }
      async json() { return typeof this._body === 'string' ? JSON.parse(this._body) : this._body; }
      async text() { return typeof this._body === 'string' ? this._body : JSON.stringify(this._body); }
      clone() { return new Response(this._body, { status: this.status, headers: this.headers }); }
    };
  }
  if (typeof globalThis.atob === 'undefined') {
    globalThis.atob = function (text) {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
      let bits = 0, value = 0, output = '';
      for (const char of String(text).replace(/\s|=/g, '')) {
        const number = chars.indexOf(char);
        if (number < 0) throw new TypeError('Invalid base64');
        value = (value << 6) | number;
        bits += 6;
        if (bits >= 8) { bits -= 8; output += String.fromCharCode((value >> bits) & 255); }
      }
      return output;
    };
  }
  if (typeof globalThis.AbortController === 'undefined') {
    globalThis.AbortController = class AbortController {
      constructor() {
        const listeners = new Set();
        this.signal = {
          aborted: false,
          addEventListener(type, fn) { if (type === 'abort') listeners.add(fn); },
          removeEventListener(type, fn) { if (type === 'abort') listeners.delete(fn); },
          _listeners: listeners,
        };
      }
      abort() {
        if (this.signal.aborted) return;
        this.signal.aborted = true;
        for (const fn of this.signal._listeners) fn({ type: 'abort' });
      }
    };
  }
  // Never turn a real delay/timeout into an immediate callback. Hosts that lack
  // timers reject only affected source paths instead of spinning or aborting all requests.
  if (typeof globalThis.setTimeout === 'undefined') {
    globalThis.setTimeout = function () { throw new Error('当前播放器脚本环境不支持计时器。'); };
    globalThis.clearTimeout = function () {};
  }
})();
