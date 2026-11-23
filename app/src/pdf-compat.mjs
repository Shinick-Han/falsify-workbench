// Newer JavaScript APIs used by the pinned PDF.js viewer and its worker.
import 'core-js/es/iterator/index.js';
import 'core-js/modules/es.promise.with-resolvers.js';
import 'core-js/modules/es.promise.try.js';
import 'core-js/modules/es.map.get-or-insert-computed.js';
import 'core-js/modules/es.weak-map.get-or-insert-computed.js';
import 'core-js/modules/es.uint8-array.from-base64.js';
import 'core-js/modules/es.uint8-array.to-base64.js';
import 'core-js/modules/es.uint8-array.to-hex.js';
import 'core-js/modules/es.array-buffer.transfer-to-fixed-length.js';
import 'core-js/modules/es.set.intersection.v2.js';
import 'core-js/modules/es.math.sum-precise.js';
import 'core-js/modules/es.map.get-or-insert.js';
import 'core-js/modules/web.url.parse.js';

// PDF.js consumes its text-content stream with for-await. Older WebKit exposes only readers.
if (typeof ReadableStream === 'function' && !ReadableStream.prototype[Symbol.asyncIterator]) {
  Object.defineProperty(ReadableStream.prototype, Symbol.asyncIterator, {
    configurable: true,
    writable: true,
    value: async function* ({preventCancel = false} = {}) {
      const reader = this.getReader();
      let done = false;
      try {
        while (!done) {
          const chunk = await reader.read();
          done = chunk.done;
          if (!done) yield chunk.value;
        }
      } finally {
        try {
          if (!done && !preventCancel) await reader.cancel();
        } finally {
          reader.releaseLock();
        }
      }
    },
  });
}
