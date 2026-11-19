import { randomInt } from 'node:crypto';

// crypto.randomInt is the default so a draw is not a Math.random sequence.
export function drawWinners(items, count, randomIntFn = randomInt) {
  const pool = items.slice();
  const winners = [];
  const take = Math.min(count, pool.length);
  for (let i = 0; i < take; i += 1) {
    const index = randomIntFn(0, pool.length);
    winners.push(pool.splice(index, 1)[0]);
  }
  return winners;
}
