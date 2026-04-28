/**
 * EpitopX AI — Structured logger
 *
 * Provides timestamped, leveled logging with context tags.
 * Levels: debug, info, warn, error
 */

'use strict';

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

class Logger {
  /**
   * @param {Object} opts
   * @param {string} [opts.level='info'] - Minimum log level
   */
  constructor(opts = {}) {
    this.level = LOG_LEVELS[opts.level] ?? LOG_LEVELS.info;
  }

  _ts() {
    return new Date().toISOString();
  }

  _log(level, tag, msg, extra) {
    if (LOG_LEVELS[level] < this.level) return;
    const prefix = `${this._ts()} [${level.toUpperCase()}] [${tag}]`;
    const line = extra !== undefined
      ? `${prefix} ${msg} ${typeof extra === 'object' ? JSON.stringify(extra) : extra}`
      : `${prefix} ${msg}`;

    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }

  debug(tag, msg, extra) { this._log('debug', tag, msg, extra); }
  info(tag, msg, extra)  { this._log('info', tag, msg, extra); }
  warn(tag, msg, extra)  { this._log('warn', tag, msg, extra); }
  error(tag, msg, extra) { this._log('error', tag, msg, extra); }

  /**
   * Log an incoming request.
   */
  request(method, url, clientIp) {
    this._log('info', 'req', `${method} ${url}`, { ip: clientIp });
  }

  /**
   * Log a proxy request to external API.
   */
  proxy(tag, method, targetUrl) {
    this._log('info', tag, `→ ${method} ${targetUrl}`);
  }

  /**
   * Log a cache event.
   */
  cache(event, url) {
    this._log('debug', 'cache', `${event}: ${url}`);
  }
}

module.exports = { Logger };
