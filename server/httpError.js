'use strict';

/** Thrown for any expected failure; the error middleware in server/app.js turns it into `{ error }`. */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

module.exports = { HttpError };
