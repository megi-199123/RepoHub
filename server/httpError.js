'use strict';

/** Thrown for any expected failure; the error middleware in server/app.js turns it into `{ error }`
 *  (plus any `extra` fields spread in — e.g. `{ error, canWatch: true }` for a full/finished room). */
class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

module.exports = { HttpError };
