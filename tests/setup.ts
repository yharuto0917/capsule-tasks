import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';
import { beforeEach } from 'vitest';

// JSDOM にない Web Locks を、全フックで共有する FIFO 排他キューとして再現する。
beforeEach(() => {
  let queue = Promise.resolve();
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: (_name: string, _options: LockOptions, callback: LockGrantedCallback<unknown>) => {
        const operation = queue.then(() => callback({ name: _name, mode: 'exclusive' }));
        queue = operation.then(
          () => undefined,
          () => undefined,
        );
        return operation;
      },
    },
  });
});

if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = () => null;
}
