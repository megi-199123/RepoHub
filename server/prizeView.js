'use strict';

/** The subset of a prize that is safe to send to any client: no weight, no stock. */
function publicPrize(p) {
  return { id: p.id, name: p.name, description: p.description, emoji: p.emoji, image: p.image, color: p.color, winning: p.winning };
}

module.exports = { publicPrize };
