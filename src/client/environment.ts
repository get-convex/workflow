import { OriginalEnv } from "./step.js";
import { StepContext } from "./stepContext.js";

export function setupEnvironment(_ctx: StepContext): OriginalEnv {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const global = globalThis as any;

  global.Math.random = () => {
    throw new Error("Math.random() isn't currently supported within workflows");
  };

  const originalDate = global.Date;
  delete global.Date;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function Date(this: any, ...args: any[]) {
    // `Date()` was called directly, not as a constructor.
    if (!(this instanceof Date)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const date = new (Date as any)();
      return date.toString();
    }
    if (args.length === 0) {
      const unixTsMs = Date.now();
      return new originalDate(unixTsMs);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new (originalDate as any)(...args);
  }
  Date.now = function () {
    throw new Error("Date.now() isn't currently supported within workflows.");
  };
  Date.parse = originalDate.parse;
  Date.UTC = originalDate.UTC;
  Date.prototype = originalDate.prototype;
  Date.prototype.constructor = Date;

  global.Date = Date;

  delete global.process;

  delete global.Crypto;
  delete global.crypto;
  delete global.CryptoKey;
  delete global.SubtleCrypto;

  global.fetch = (_input: RequestInfo | URL, _init?: RequestInit) => {
    throw new Error(
      `Fetch isn't currently supported within workflows. Perform the fetch within an action and call it with step.runAction().`,
    );
  };
  return { Date: originalDate };
}
