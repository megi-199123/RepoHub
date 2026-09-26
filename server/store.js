'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const newId = () => crypto.randomUUID();

function defaultData() {
  const now = new Date().toISOString();
  const prize = (name, description, emoji, color, weight, stock, winning = true) => ({
    id: newId(),
    name,
    description,
    emoji,
    image: null,
    color,
    weight,
    stock,
    winning,
    active: true,
    createdAt: now,
  });

  return {
    settings: {
      title: 'Mystery Box',
      subtitle: 'Pick a box. Any box. Fortune favours the bold.',
      boxCount: 4,
      assignment: 'unique',
      showPrizes: true,
      maxPlaysPerVisitor: 0,
    },
    prizes: [
      prize('Grand Prize', 'A brand-new smartphone', '📱', '#f59e0b', 1, 1),
      prize('Gift Voucher', '₱500 shopping voucher', '🎟️', '#ec4899', 3, 20),
      prize('Free Coffee', 'One cup on the house', '☕', '#8b5cf6', 6, null),
      prize('Better Luck', 'Thanks for playing — try again!', '🍀', '#10b981', 10, null, false),
    ],
    draws: [],
  };
}

/**
 * Tiny JSON-file persistence. Writes are synchronous and atomic
 * (write to temp file, then rename) so a crash never leaves a half-written file.
 */
class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'db.json');
    this.uploadsDir = path.join(dataDir, 'uploads');
    fs.mkdirSync(this.uploadsDir, { recursive: true });

    if (fs.existsSync(this.file)) {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      // Backfill any settings added in newer versions.
      this.data.settings = { ...defaultData().settings, ...this.data.settings };
      this.data.draws ||= [];
      for (const p of this.data.prizes) p.winning ??= true;
    } else {
      this.data = defaultData();
      this.save();
    }
  }

  save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  get settings() {
    return this.data.settings;
  }

  get prizes() {
    return this.data.prizes;
  }

  get draws() {
    return this.data.draws;
  }

  findPrize(id) {
    return this.data.prizes.find((p) => p.id === id);
  }
}

module.exports = { Store, newId };
